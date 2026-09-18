"use strict";

const { estimateActedSpeechSeconds, speechRatePolicy, speechWindowBounds } = require("./drama-timing");

const { inferDialogueTone } = require("./dialogue-parser");
const { canonicalizeStagingShot, sourceSoundTimeline, physicalContinuityDirections, castRows, isOffscreen } = require("./drama-staging-contract");

// Live A/B evidence showed that merely omitting the unwanted concept was not
// sufficient: H3 sometimes added a graphic speech layer of its own.  Keep the
// provider instruction positive and production-native (a clean camera-original
// plate) without naming or visually priming any specific unwanted artefact.
const HAILUO_LEGACY_FINAL_OUTPUT_LOCK = "The deliverable is a clean full-frame camera-original live-action plate: every visible pixel belongs to the photographed story world, and spoken dialogue exists only as synchronized voice with matching lip movement.";
const HAILUO_FINAL_OUTPUT_LOCK = "The deliverable is a clean full-frame camera-original live-action plate: every visible pixel belongs to the photographed story world. On-screen dialogue synchronizes only its named speaker's lips; off-screen dialogue leaves every visible mouth closed.";
const HAILUO_INTEGRATED_PROMPT_HEADER = "integrated_multimodal_description（多模态综合描述）";
const HAILUO_INTEGRATED_OUTPUT_LOCK_ZH = "成片始终是完整、连续的真人剧情摄影画面；画面内每个可见元素都属于剧情世界，画内对白只驱动指定说话人的口型，画外对白期间所有可见人物保持闭口。";
const SCREEN_TEXT_CONCEPT_RE = /\b(?:subtitles?|captions?|on[- ]screen\s+text|screen\s+text|title\s+cards?|watermarks?|name\s+tags?)\b/i;

function clean(value) {
  return String(value || "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

// Provider prompts must never contain a positive acoustic instruction for an
// unauthored crowd voice or non-dialogue vocalisation. H3 can prioritise an
// early positive cue such as "background guests chat" over a later negative
// sound lock, so normalise those cues at their source instead of relying on a
// trailing prohibition.
function sanitizeUnauthoredVocalSound(value) {
  return clean(value)
    .replace(/\b(?:crowd\s+)?(?:chatter|murmurs?|murmuring|talking|conversation|voices?|whispers?|shouts?|cheers?)\b/gi, "silent crowd movement")
    .replace(/\b(?:light\s+|soft\s+|quiet\s+|faint\s+)?(?:laughter|laughing|giggles?|giggling|chuckles?|chuckling)\b/gi, "silent visible smiles")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeExactDialoguePerformance(value) {
  return clean(value)
    .replace(/\b(?:a|an)\s+(?:(?:dry|involuntary|sharp|audible|sudden)\s+)*gasp\b/gi, "a brief silent pause")
    .replace(/\bopens?\s+with\s+(?:a\s+)?(?:laugh|laughter|chuckle|giggle)\b/gi, "opens with a visible smile")
    .replace(/\bwith\s+(?:a\s+)?(?:laugh|laughter|chuckle|giggle)\b/gi, "with a visible smile")
    .replace(/\b(?:laughs?|laughing|laughter|chuckles?|chuckling|giggles?|giggling)\b/gi, "smiles visibly")
    .replace(/\b(?:sighs?|sighing)\b/gi, "shows a silent visible exhale")
    .replace(/\b(?:gasps?|gasping)\b/gi, "shows a silent widened-eye reaction")
    .replace(/\bone clean pause after\s*(?=[,.;:]|$)/gi, "one clean pause")
    .replace(/\b(?:hard|firm|sharp)\s+stress\s+on(?:\s+the\s+(?:word|phrase))?\s*(?=[,.;:]|$)/gi, "firm keyword stress")
    .replace(/\bstress\s+and\s*(?=[,.;:]|$)/gi, "firm keyword stress")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeSilentBackgroundDirection(value) {
  return clean(value)
    .replace(/\bstop\s+(?:(?:laughing|chatting|talking)(?:\s+and\s+)?)+/gi, "stop all silent social movement and hold their mouths closed ")
    .replace(/\bchat(?:ting)?\s+and\s+/gi, "silently mingle and ")
    .replace(/\b(?:talking|chatting|chattering|conversing)\b/gi, "moving silently")
    .replace(/\b(?:laughing|giggling|chuckling)\b/gi, "smiling silently")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(value) {
  return [...new Set(list(value).map(clean).filter(Boolean))];
}

// Position and gaze are different contracts. "C02 remains screen-right,
// turns screen-left toward C01" must never relocate C02 to the left.
function authoredScreenSide(value, actorId = "", actorName = "") {
  const source = clean(value);
  const normalize = token => /left|左/i.test(token) ? "screen-left" : /right|右/i.test(token) ? "screen-right" : "screen-center";
  if (/^(?:screen[- ](?:left|right|center)|画面[左右中]|[左右]侧|中央|正中)$/i.test(source)) return normalize(source);
  const aliases = unique([actorId, actorName]).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const prefix = aliases.length ? `(?:${aliases.join("|")})\\b` : "(?:^|[.;])";
  const ownPosition = new RegExp(`${prefix}[^.;]{0,65}?\\b(?:remains?|holds?|stands?|stays?|is positioned|is located|occupies?)\\s+(?:at |on |in )?(?:the )?(screen[- ](?:left|right|center))`, "i").exec(source);
  if (ownPosition) return normalize(ownPosition[1]);
  const chinese = aliases.length && new RegExp(`(?:${aliases.join("|")})[^，。；]{0,18}(?:站在|位于|保持在|处于)(?:画面)?(左侧|右侧|中央|正中)`).exec(source);
  return chinese ? normalize(chinese[1]) : "";
}

function hasRecipientTreatmentAction(value) {
  // Do not interpret the noun in "wedding dress ... right hand" as the
  // transitive verb "dress" and hallucinate a patient/body-part contract.
  const source = clean(value);
  const verb = /\b(?:appl(?:y|ies|ied|ying)|massag(?:e|es|ed|ing)|rub(?:s|bed|bing)?|brush(?:es|ed|ing)?|comb(?:s|ed|ing)?|wash(?:es|ed|ing)?|dy(?:e|es|ed|eing)|treat(?:s|ed|ing)?|wip(?:e|es|ed|ing)|clean(?:s|ed|ing)?|bandag(?:e|es|ed|ing))\b/i;
  const dressing = /\bdress(?:es|ed|ing)?\s+(?:<Subject\s+\d+>|C\d+|(?:the\s+)?(?:patient|recipient|wound))\b/i;
  return (verb.test(source) || dressing.test(source))
    && /\b(?:hair|head|temples?|roots?|scalp|face|collar|sleeves?|lapels?|shoulders?|arms?|hands?|back)\b/i.test(source);
}

// Only shorten compiler-owned, semantically duplicated scaffolding. Never
// slice authored dialogue, acting cues, reference bindings or timed actions.
function compactGeneratedPromptBoilerplate(prompt, ceiling = 9800) {
  if (String(prompt).length <= ceiling) return prompt;
  const replacements = [
    ["Reference assets lock identity, location, objects, product and wardrobe; begin at the authored before-state and end with the authored action visibly complete.", "References lock identities and physical continuity; complete the authored state change."],
    ["Ensemble coverage: use a motivated medium-wide cutaway to show several anonymous background bystanders applaud together with clearly visible hands and shared timing; every extra remains a silent story-world participant with resting lips. Return by direct cut to the principal characters on the same 180-degree axis and unchanged screen directions.", "For the authored crowd beat, cut medium-wide to silent bystanders applauding, then return on the same axis and screen directions."],
    ["preserve their established distance, foreground/background depth and unobstructed faces", "preserve distance, depth and readable faces"],
    ["Complete the same single authored action from the prior physical state without restarting or replaying it.", "Continue the same physical action without replay."],
    ["no one speaks; every visible mouth remains at rest while the remaining authored physical action and visible reaction continue into the exact final state. Never freeze, wait idly, or add another line.", "all mouths rest while the remaining authored action and reaction reach the exact final state; no idle hold or added speech."],
    ["only at the corresponding visible physical event within this window; below dialogue, spatially attached to its source, once per actual event.", "once at the corresponding physical event, located at its source and below dialogue."],
    ["cut only to the next authored on-screen speaker's established face; identity never changes inside a face. An off-screen voice never acquires a visible mouth or forces a camera cut.", "direct hard cut to the next visible speaker; keep identities stable. Off-screen voices have no visible mouth or forced cut."],
    ["From 0.00 to 0.30 seconds, all visible mouths remain fully closed and silent; establish the authored blocking with room tone only. After 0.30 seconds, begin the first syllable once and cleanly, with no lip smack, tongue click, throat clear, inhale vocalization, false start, filler syllable or cut-off sound.", "From 0.00 to 0.30 seconds, mouths stay closed with room tone only. Then begin the first syllable once, without mouth noise or false starts."],
    ["Every person, product and prop remains one unique physical instance; preserve identity, age, wardrobe, holder, location geometry, light, screen direction and the 180-degree eyeline axis.", "Every person, product and prop remains one unique physical instance; preserve appearance, holders, spatial continuity and the 180-degree eyeline axis."],
    ["A principal character may enter only through an authored doorway or frame edge in a visible continuous entrance beat before speaking; never materialize, teleport, swap screen sides, or appear between cuts without an entrance action and state handoff.", "Show each authored entrance continuously through its doorway or frame edge before speech; no teleportation, side swap or unexplained appearance."],
    ["Reference images establish identity, appearance, space, product and prop continuity only; never photograph or reproduce an asset board, contact sheet, split view, label, interface or reference file inside the story frame.", "References lock identity and continuity only; never reproduce reference boards, grids, labels or interfaces in the story frame."],
    ["Only the authored Chinese dialogue enclosed by the dialogue tags above is spoken; every other sentence is silent direction.", "Speak only the exact tagged Chinese dialogue; all other prose is silent direction."],
    ["Every dialogue line has one clean onset and one final syllable only: no mouth click, tongue click, lip smack, throat clear, inhale vocalization, false start, repeated line, restart, echo or partial duplicate.", "Every line has one clean onset and ending: no mouth noise, false start, repeated syllable, restart, echo or overlap."],
    ["At any instant, at most one authored speaker is audible; all others stay silent, with no overlap, improvised word, background vocal sound or decorative noise.", "Only one authored speaker is audible at a time; no overlap, improvised words or background voices."],
    ["exact face, age, body and immutable identity come from", "identity, age and physique match"],
    ["keep its shown hair and wardrobe unless the authored story explicitly changes that state", "preserve shown hair and wardrobe until an authored change"],
    ["identity/age/body/role fixed; hair/wardrobe as authored", "identity and current authored appearance remain stable"],
    ["The line is complete before the window ends at no less than", "Finish the complete line inside this window at no less than"],
    [", with no false start, restart, trailing syllable, or cut-off word.", "; no false start or cut-off word."]
    ,["Resolve every instruction in this order: exact words and speaker, vocal tone, visible emotion, causal action, then blocking and facing.", "Priority: exact words/speaker, vocal tone, emotion, causal action, blocking/facing."]
    ,["preserve shown hair and wardrobe until an authored change", "keep current hair and wardrobe until changed in-story"]
    ,["identity, age and physique match", "identity/age/body match"]
    ,["architecture, furnishings, lighting, and camera axis come from", "geometry, set, lighting and axis match"]
    ,["appearance, scale, holder, and physical state remain stable", "appearance, scale, state and holder stay fixed"]
    ,["preserve vocal identity while speaking only the authored dialogue in this prompt", "use timbre only for exact tagged dialogue"]
    ,["Keep room tone and visible-source action sound continuous through the final frame.", "Keep room tone and source sounds continuous to the final frame."]
    ,["Then begin the first syllable once, without mouth noise or false starts.", "Then begin the first syllable once: no lip smack, tongue click, throat clear, inhale vocalization, false start or cut-off sound."]
    ,["Only one authored speaker is audible at a time; no overlap, improvised words or background voices.", "Only one authored speaker is audible at a time; no overlap, improvised word, background vocal sound or decorative noise."]
    ,["Show each authored entrance continuously through its doorway or frame edge before speech; no teleportation, side swap or unexplained appearance.", "A principal character may enter only through an authored doorway or frame edge, continuously before speech; no teleportation or side swap."]
  ];
  replacements.push(
    ['whose architecture, furnishings, lighting, and physical geometry come from', 'whose set, light and geometry match'],
    ['the authored camera timeline controls viewing direction, not the reference-board layout.', 'authored camera beats set viewing direction, not board layout.'],
    ['fixed architecture, furniture, geometry and scale remain stable; current authored time, lighting, object states and camera beats take precedence.', 'set, light, geometry and scale stay fixed; camera beats set the view.'],
    ['whose exact appearance and scale come from', 'whose appearance and scale match'],
    ['its holder and physical state follow the authored action timeline.', 'holder and state follow authored actions.'],
    ['appearance and scale remain stable; holder and physical state change only through the authored actions.', 'appearance and scale stay fixed; authored actions change holder and state.'],
    ['Every person, product and prop remains one unique physical instance; preserve identity, age, current wardrobe, location geometry, light, screen direction and the 180-degree eyeline axis. Holder and physical state follow the exact authored changes, never freeze a prop in its reference pose.', 'Every person, product and prop remains one unique physical instance; preserve identity, age, current wardrobe, set, light, screen direction and the 180-degree eyeline axis. Authored actions change holders and physical state; reference poses never freeze them.'],
    ['Use only the assigned speaker timbres for the exact once-only Chinese lines; all other people remain silent.', 'Only assigned timbres speak the exact Chinese lines once; everyone else stays silent.'],
    ['The treatment recipient is', 'Treatment recipient:'],
    ['framing: honor each authored camera beat; keep its speaker readable without cropping required listeners, entrances, hands or contact. Preserve the axis; no forced face close-up.', 'Framing: follow authored camera beats; show required speaker, listener, entrance, hands and contact on the established axis.'],
    ['switch camera ownership and speaking-mouth ownership together with a direct hard cut to the next authored on-screen speaker\'s established face.', 'switch camera ownership and speaking-mouth ownership together with a direct hard cut to the next named speaker.'],
    ['Begin with the preceding shot\'s exact final physical state; finish with the same established physical state, retaining the performed emotional change.', 'Start at the preceding exact end-state; preserve physical continuity and the performed emotional change.'],
    ['Finish the complete line inside this window at no less than', 'Finish this entire line in-window at no less than'],
    ['One material-appropriate impact occurs at the visible object-to-surface contact, followed only by the shown bounce, rattle or settling decay; no impact at release', 'One material-matched impact at visible surface contact; only shown bounce, rattle or settling decay; none at release'],
    ['Individual footfalls follow each visible foot planting on the established floor, with distance changing along the walking path; stop when the feet stop', 'Footfalls sync to each visible foot plant; perspective follows distance and stops with the feet'],
    ['whose exact appearance, scale, and holder continuity come from', 'whose appearance, scale and holder continuity match'],
    ['voice-timbre reference for', 'voice identity for'],
    ['architecture, furnishings, lighting, spatial axis, and scale remain stable', 'set, lighting, axis and scale remain stable'],
    ['preserve appearance, holders, spatial continuity and the 180-degree eyeline axis', 'preserve appearance, holders, space and the 180-degree eyeline axis'],
    ['use only its vocal identity and do not repeat its source utterance', 'copy timbre only, never its source words'],
    ['Camera: Keep the established camera treatment and axis, framing the current named active speaker; do not replay completed cutaways.', 'Camera: retain treatment and axis; frame the current speaker without replaying completed cutaways.'],
    ['Background and listener action: Continue the established silent background reaction without replay.', 'Listener/background: continue the established silent reaction without replay.'],
    ['fixed architecture, furniture and geometry from', 'set and geometry from'],
    ['time of day, lighting, movable objects and viewing direction follow the current authored shot.', 'lighting, objects and viewing angle follow the shot.'],
    ['once at the corresponding physical event, located at its source and below dialogue.', 'once at source event, below dialogue.'],
    ['Only assigned timbres speak the exact Chinese lines once; everyone else stays silent.', 'Only assigned timbres speak the exact Chinese lines once; others remain silent.']
  );
  return String(prompt).split(/(<d>[\s\S]*?<\/d>)/gi).map(part => {
    if (/^<d>/i.test(part)) return part;
    for (const [from, to] of replacements) part = part.split(from).join(to);
    return part;
  }).join("");
}

function providerStableId(value, fallback = "") {
  const token = clean(value).replace(/[^A-Za-z0-9_.:-]+/g, "");
  return token || fallback;
}

function englishOnly(value, fallback = "", maxLength = 180) {
  const text = clean(value)
    .replace(/[\u3400-\u9fff\uf900-\ufaff]+/g, " ")
    .replace(/[\u3000-\u303f\uff00-\uffef]+/g, " ")
    .replace(/[“”‘’]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const usable = (text.match(/[A-Za-z]/g) || []).length >= 2 ? text : fallback;
  const source = String(usable || "").trim();
  // A length hint must not silently erase an authored action/consequence or
  // replace it with a generic sentence. Concision belongs to reviewed writing.
  return source;
}

function productionCue(value, kind, fallback, maxLength) {
  const source = clean(value);
  if (!/[\u3400-\u9fff]/.test(source)) return englishOnly(source, fallback, maxLength);
  // Mixed-language authoring is common when an English delivery cue names the
  // exact Chinese word that receives stress. Keep the usable English direction
  // instead of degrading the whole cue to a generic fallback merely because a
  // Chinese keyword is present.
  const embeddedEnglish = englishOnly(source, "", maxLength);
  const cues = [];
  if (kind === "delivery") {
    if (/轻声|轻柔|安心|安慰|温柔/.test(source)) cues.push("soft, reassuring, even pace");
    if (/怒|火|质问|斥/.test(source)) cues.push("restrained anger, clipped stress");
    if (/急切|焦急|着急|急促/.test(source)) cues.push("urgent but clearly articulated, not automatically angry");
    if (/厉声|爆发|喝止|喊|高(?:音量)?/.test(source)) cues.push("high volume, sharp attack");
    if (/极快|急促|语速快/.test(source)) cues.push("fast pace, clipped breath");
    if (/重音|强调|落重/.test(source)) cues.push("firm keyword stress");
    if (/哭|颤|哽咽|心虚/.test(source)) cues.push("tearful breath, trembling tail");
    if (/慢|停顿|压低/.test(source)) cues.push("lower volume, slower ending");
  } else if (kind === "body") {
    if (/扑|冲|跨步/.test(source)) cues.push("body lunges forward");
    if (/托|扶|垫|搀/.test(source)) cues.push("arms catch and support weight");
    if (/拦|挡/.test(source)) cues.push("forearm blocks the path");
    if (/收紧|握紧|抓紧/.test(source)) cues.push("grip visibly tightens");
    if (!cues.length && /手|抬|放|推|拉|递|抓/.test(source)) cues.push("clear motivated hand action");
    if (/眼|视线|看|盯/.test(source)) cues.push("gaze lands on the listener");
    if (/前|后|重心|身体/.test(source)) cues.push("visible weight shift");
  } else if (kind === "reaction") {
    cues.push("still lips");
    if (/失衡|托住|扶住/.test(source)) cues.push("balance jolts, then settles into support");
    if (/呼吸顿住|屏住/.test(source)) cues.push("breath catches visibly");
    if (/收紧|握紧|护着/.test(source)) cues.push("protective grip tightens");
    if (/后退|退/.test(source)) cues.push("visible retreat");
    if (/愣|停|僵/.test(source)) cues.push("brief frozen reaction");
    if (/眼|看|盯|视线/.test(source)) cues.push("gaze reaction");
  } else if (kind === "camera") {
    if (/切/.test(source)) cues.push("hard cut on speaker change");
    if (/推/.test(source)) cues.push("slow push-in");
    if (/跟/.test(source)) cues.push("motivated tracking move");
    if (/摇/.test(source)) cues.push("controlled pan");
    if (/近景|特写/.test(source)) cues.push("readable facial close-up");
  }
  return englishOnly(unique([embeddedEnglish, ...cues]).join(", "), fallback, maxLength);
}

function metadataCue(value, fallback = "", maxLength = 180) {
  const cue = englishOnly(value, "", maxLength);
  return cue && !SCREEN_TEXT_CONCEPT_RE.test(cue)
    ? cue
    : englishOnly(fallback, "", maxLength);
}

// Blueprint-off and imported projects can legitimately contain only Chinese
// authored production fields. Convert observable verbs to deterministic silent
// provider metadata so the exact action is not replaced by a generic gesture.
function deterministicEnglishCue(value, kind = "action", fallback = "", maxLength = 180) {
  const source = clean(value);
  if (!source) return metadataCue("", fallback, maxLength);
  if (!/[\u3400-\u9fff]/.test(source)) return metadataCue(source, fallback, maxLength);
  const cues = [];
  const add = (pattern, cue) => { if (pattern.test(source)) cues.push(cue); };
  if (kind === "state") {
    // Chinese state fields often name a specific actor.  Guessing that actor as
    // "the listener" silently swapped Su Mei and Wang Qin in real H3 prompts.
    // Preserve only neutral, directly observable geometry here; ownership-rich
    // states are translated by the one-batch ID-aware compiler instead.
    add(/一步距离|一步外/, "the other character remains one step away");
    add(/对视|视线相锁|盯住彼此/, "both characters hold a tense locked eyeline");
    add(/半空/, "one reaching hand stops in midair");
    add(/压在|按在/, "the authored object remains visibly pinned on the surface");
    add(/托住|扶稳|抱稳/, "one body remains visibly supported and stable");
    return metadataCue(unique(cues).join("; then "), fallback, maxLength);
  }
  if (kind === "camera") {
    add(/特写/, "facial close-up");
    add(/近景|中近景/, "medium close-up");
    add(/反打/, "shot-reverse-shot on the active face");
    add(/固定|稳镜|机位稳|^稳/, "stable camera");
    add(/推近|前推|推/, "restrained push-in");
    add(/跟|跟拍/, "brief motivated tracking move");
    add(/低机位|略低/, "slightly low camera height");
    add(/轴线|180/, "preserve the 180-degree eyeline axis");
    add(/群众|众人|宾客|亲友|同事|路人|围观|掌声|鼓掌|喝彩|欢呼/, "direct cut to a motivated medium-wide ensemble reaction, then return to the principal story axis");
  } else if (kind === "sound") {
    add(/底噪|环境声|室内/, "continuous room tone");
    add(/呼吸|喘/, "synchronized strained breathing");
    add(/衣料|布料/, "cloth movement");
    add(/床|床板/, "bed-frame movement");
    add(/撞|闷响|坠地|扑地/, "body impact");
    add(/脚步|走路/, "footsteps");
    add(/摩擦|轻蹭/, "surface friction");
    add(/纸|证据/, "paper movement");
    add(/剪刀|剪开|剪断|剪纸|剪碎/, "one synchronized metal scissors snip and the exact paper-or-fabric cut sound");
    add(/摔下|摔在|摔桌|砸下|砸在|拍桌|拍案|撞桌|重重放下/, "one synchronized object impact on the authored surface");
    add(/门铃/, "one clearly motivated doorbell ring from the established entrance");
    add(/撕纸|撕开|撕碎|撕掉/, "one synchronized paper tear");
    add(/鼓掌|掌声/, "synchronized audience applause matching the visible group reaction");
    add(/开门|推门|关门|带上门/, "synchronized door movement from the established doorway");
    add(/手机震动|电话震动/, "one short synchronized phone vibration");
  } else {
    add(/失衡|坠|跌|摔/, "the unstable person loses balance and drops");
    add(/扑|冲过去|跨步/, "the active character lunges forward");
    add(/垫|托住|扶住|搀|扶稳/, "one character catches and supports the other's weight");
    add(/伸手|拦|挡/, "an arm reaches out to block the path");
    add(/推[^，。；]*?(证据|纸|物)|(?:证据|纸|物)[^，。；]*?推/, "the held object slides across the surface toward the listener");
    add(/递|交给/, "the held object is passed into the listener's reach");
    add(/拿起|拾起|捡起/, "a hand lifts the authored object");
    add(/拿出|取出|掏出/, "the character takes the authored object out into view");
    add(/滑出|掉出|落出/, "the authored object slips into view");
    add(/放下|落下/, "the authored object is set down visibly");
    add(/抓|攥|握紧|收紧手/, "the hand tightens its grip");
    add(/收紧手臂|抱紧/, "the supporting arms tighten and stabilize the body");
    add(/后退|退半步|退开/, "the authored named character retreats a visible half-step");
    add(/起身|站起/, "the character rises to standing");
    add(/坐下|坐稳/, "the character settles into a stable seated position");
    add(/转身|回身/, "the character turns toward the new eyeline");
    add(/走|迈步|上前/, "the character takes a motivated step");
    add(/盯|对视|视线|看向/, "their eyelines lock on each other");
    add(/一步距离|一步外/, "the other character remains one step away");
    add(/鼓掌|掌声/, "several background bystanders applaud together in one clearly visible group reaction");
    add(/欢呼|喝彩/, "the background group gives one clearly visible celebratory reaction");
    add(/群众|众人|宾客|亲友|同事|路人|围观/, "the authored background ensemble reacts together while the principal characters remain spatially continuous");
    // “贴” is also used by ordinary story actions such as “把旧照片贴在掌心”.
    // Treating every occurrence as a wearable-product action silently rewrote
    // evidence props into merchandise.  Only explicit wearable nouns/verbs may
    // enter this provider cue; product-specific use is authored elsewhere.
    add(/护膝|护腕|护腰|矫正器|固定器|助听器|佩戴|穿戴|戴上(?:护膝|护腕|护腰|矫正器|固定器|助听器|眼镜|口罩)/, "both hands fit and secure the referenced wearable item on the intended body area");
    add(/打开|拆开/, "hands open the authored object and expose its contents");
  }
  return metadataCue(unique(cues).join("; then "), fallback, maxLength);
}

function authoredEnsembleReaction(shot = {}, segments = []) {
  const source = clean([
    shot?.action,
    shot?.visualBeat,
    shot?.performance,
    shot?.stateAfter,
    shot?.actionEn,
    shot?.visualBeatEn,
    ...list(shot?.subshots).flatMap(item => [item?.action, item?.visualBeat, item?.camera, item?.framing, item?.sound]),
    ...list(segments).flatMap(item => [item?.action, item?.camera, item?.backgroundAction])
  ].filter(Boolean).join(" "));
  if (!/(?:群众|众人|宾客|亲友|同事|路人|围观|掌声|鼓掌|喝彩|欢呼|audience|crowd|bystanders?|guests?|onlookers?|applaud|clap|cheer)/i.test(source)) return "";
  const action = /(?:鼓掌|掌声|applaud|clap)/i.test(source)
    ? "several anonymous background bystanders applaud together with clearly visible hands and shared timing"
    : /(?:欢呼|喝彩|cheer)/i.test(source)
      ? "the anonymous background group gives one clearly visible celebratory reaction"
      : "the authored anonymous background ensemble gives one clearly visible collective reaction";
  return `Ensemble coverage: use a motivated medium-wide cutaway to show ${action}; every extra remains a silent story-world participant with resting lips. Return by direct cut to the principal characters on the same 180-degree axis and unchanged screen directions.`;
}

const ACTION_COVERAGE_STOP_WORDS = new Set([
  "a", "active", "an", "and", "authored", "body", "character", "each", "exact", "he", "her", "his",
  "one", "other", "person", "she", "the", "their", "them", "then", "they", "to",
  "visible", "while", "with"
]);

function actionCoverageTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [])
    .map(word => word.replace(/'(?:s)?$/, ""))
    .filter(word => !ACTION_COVERAGE_STOP_WORDS.has(word))
    .map(word => {
      if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3).replace(/([bcdfghjklmnpqrstvwxyz])\1$/, "$1");
      if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
      if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2).replace(/([bcdfghjklmnpqrstvwxyz])\1$/, "$1");
      if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
      if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
      return word;
    })
    .filter(Boolean);
}

function actionCoverageScore(value, candidate) {
  const expected = unique(actionCoverageTokens(value));
  const actual = new Set(actionCoverageTokens(candidate));
  if (!expected.length || !actual.size) return 0;
  return expected.filter(token => actual.has(token)).length / expected.length;
}

function masterActionClauses(shot = {}) {
  const master = deterministicEnglishCue(
    shot?.actionEn || shot?.visualBeatEn || shot?.action,
    "action",
    "",
    360
  );
  return unique(master
    .split(/\s*;\s*(?:then\s+)?|(?<=[.!?])\s+|,\s+(?=(?:and\s+)?then\b)/i)
    .map(value => metadataCue(value, "", 86))
    .filter(value => value && !/\b(?:asks?|dialogue|repl(?:y|ies)|says?|shouts?|speaks?|spoken|yells?)\b/i.test(value)));
}

function overlappingSegmentIndex(segments = [], turn = {}) {
  const start = Number(turn?.start ?? turn?.startSecond);
  const end = Number(turn?.end ?? turn?.endSecond);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return -1;
  let bestIndex = -1;
  let bestOverlap = 0;
  list(segments).forEach((segment, index) => {
    const overlap = Math.max(0, Math.min(Number(segment.end) || 0, end) - Math.max(Number(segment.start) || 0, start));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * A standardized shot-level action is the master causal contract. Subshot
 * planning may legitimately distribute most of it, but must not silently drop
 * a physical clause. Add only clauses absent from all timed visual/state/body
 * metadata and place each one in the most relevant timed segment. This is a
 * constructive prompt compile, not a post-result rejection gate.
 */
function completeMasterActionCoverage(shot = {}, segments = [], turns = [], dialogueBodyCues = []) {
  const sourceSegments = list(segments);
  // providerTimedDirections is the ID-aware, chronologically authored output
  // of the one-batch semantic compiler.  Re-injecting the shot-level summary
  // after that compile duplicated pickups and could append an earlier beat
  // after a later one (for example, show an object and then enter the room).
  // Treat the timed provider plan as authoritative; the heuristic below is
  // only a backward-compatible repair for legacy shots with no timed plan.
  if (list(shot?.providerTimedDirections).some(item => clean(item?.actionEn || item?.visualEn))) {
    return sourceSegments;
  }
  const clauses = masterActionClauses(shot);
  if (!clauses.length || !sourceSegments.length) return sourceSegments;
  if (sourceSegments.length === 1) {
    const master = metadataCue(clauses.join("; then "), "", 360);
    const current = clean(sourceSegments[0]?.action);
    const generic = /authored (?:intent|action)|face and body follow|advance the authored/i.test(current);
    if (master && (generic || actionCoverageScore(master, current) < 0.9)) {
      return [{ ...sourceSegments[0], action: master }];
    }
  }
  const coverage = [
    ...sourceSegments.flatMap(segment => [segment.action, segment.before, segment.after]),
    ...list(dialogueBodyCues)
  ].filter(Boolean);
  const coverageText = coverage.join("; ");
  const missing = clauses.filter(clause => {
    const tokens = unique(actionCoverageTokens(clause));
    return tokens.length && actionCoverageScore(clause, coverageText) < 0.75;
  });
  if (!missing.length) return sourceSegments;

  if (sourceSegments.length === 1) {
    // A dialogue reflow may replace a specific one-beat action with a generic
    // camera placeholder. Restore the complete authored master action in that
    // single physical window; shortening it here would defeat duration and
    // action-completion validation downstream.
    const master = metadataCue(clauses.join("; then "), "", 360);
    if (master) return [{ ...sourceSegments[0], action: master }];
  }

  const additions = new Map();
  missing.forEach((clause, clauseIndex) => {
    let targetIndex = -1;
    let bestScore = 0;
    list(turns).forEach(turn => {
      const metadata = turn?.metadata || {};
      const authoredBody = [metadata?.body, turn?.bodyEn, turn?.body].filter(Boolean).join("; ");
      const bodyCue = deterministicEnglishCue(authoredBody, "action", "", 160);
      const score = actionCoverageScore(clause, bodyCue);
      const segmentIndex = overlappingSegmentIndex(sourceSegments, turn);
      if (segmentIndex >= 0 && score > bestScore) {
        bestScore = score;
        targetIndex = segmentIndex;
      }
    });
    if (targetIndex < 0) {
      sourceSegments.forEach((segment, index) => {
        const score = actionCoverageScore(clause, [segment.action, segment.before, segment.after].filter(Boolean).join("; "));
        if (score > bestScore) {
          bestScore = score;
          targetIndex = index;
        }
      });
    }
    if (targetIndex < 0) targetIndex = Math.min(sourceSegments.length - 1, Math.floor(clauseIndex * sourceSegments.length / Math.max(1, missing.length)));
    const concise = metadataCue(clause
      .replace(/\bthe active character\b/gi, "the character")
      .replace(/\bone character\b/gi, "a character")
      .replace(/^then\b[\s,:;-]*/i, ""), "", 180);
    if (concise) additions.set(targetIndex, unique([...(additions.get(targetIndex) || []), concise]));
  });

  return sourceSegments.map((segment, index) => {
    const supplement = (additions.get(index) || []).join("; then ");
    if (!supplement) return segment;
    const supplementTokens = new Set(actionCoverageTokens(supplement));
    const baseTokens = new Set(actionCoverageTokens(segment.action));
    if ([...supplementTokens].every(token => baseTokens.has(token))) return segment;
    const supplementSafe = metadataCue(supplement, "", 220).replace(/^then\b[\s,:;-]*/i, "");
    if (!supplementSafe) return segment;
    const baseBudget = Math.max(80, 340 - supplementSafe.length - 7);
    const base = metadataCue(segment.action, "advance the authored action", baseBudget);
    return { ...segment, action: `${base}; then ${supplementSafe}` };
  });
}

function spokenCharacterCount(value) {
  return clean(value).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "").length;
}

function timestamp(value, compact = false) {
  const fixed = preciseSecondTimestamp(value);
  return compact ? fixed.replace(/\.0$/, "") : fixed;
}

function officialClockTimestamp(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function preciseSecondTimestamp(value) {
  return (Number(value) || 0).toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0");
}

function providerSpeechWindowSeconds(value) {
  const seconds = Math.max(0.25, Number(value) || 0.25);
  // Provider timestamps are emitted with decimal precision and downstream
  // package validators compare the serialized window, not the unrounded
  // floating-point value. Always round capacity upward so 2.07 seconds becomes
  // 2.1 rather than 2.0. Editorial timing already carries its own 0.2-second
  // breath/handoff cushion, so do not compound another margin here.
  return Number((Math.ceil((seconds - 1e-9) * 10) / 10).toFixed(1));
}

// Advisory timing only. It never deletes dialogue or rejects a shot.
function dialogueTimingPlan(dialogueTurns = [], durationSeconds = 10) {
  const duration = Math.max(1, Number(durationSeconds) || 10);
  const turns = list(dialogueTurns);
  // A silent unit has no speech boundary. Returning the historic 0.25-second
  // clean lead as speechSpan caused the visual timeline to be split at 0.25s,
  // creating an extra pseudo-shot and replaying the first physical action.
  if (!turns.length) {
    return {
      duration,
      reactionTail: duration,
      speechSpan: 0,
      requiredSpeechSeconds: 0,
      recommendedDuration: duration,
      overflow: false,
      overflowSeconds: 0,
      authoredTimingAdequate: false,
      editorialTiming: false,
      slots: []
    };
  }
  const plannedSpeech = turns.map(turn => Number(
    turn?.plannedSpeechSeconds
    ?? turn?.speechSeconds
    ?? turn?.metadata?.plannedSpeechSeconds
    ?? turn?.metadata?.speechSeconds
  ));
  const plannedAfterBeats = turns.map(turn => Number(
    turn?.plannedAfterBeatSeconds
    ?? turn?.afterBeatSeconds
    ?? turn?.metadata?.plannedAfterBeatSeconds
    ?? turn?.metadata?.afterBeatSeconds
  ));
  const hasEditorialTiming = turns.length > 0 && plannedSpeech.every(value => Number.isFinite(value) && value > 0);
  const speechBounds = turns.map(turn => speechWindowBounds(turn?.text || turn?.spokenText, turn));
  const required = turns.map((turn, index) => {
    const bounds = speechBounds[index];
    const deterministic = estimateActedSpeechSeconds(turn?.text || turn?.spokenText, turn);
    const authored = hasEditorialTiming ? Math.min(bounds.maxSeconds, Math.max(bounds.minSeconds, plannedSpeech[index])) : 0;
    // The deterministic acted-speech clock is the floor even when an Agent
    // supplies editorial timing. Never let an optimistic Agent estimate
    // shorten a line, then convert that floor to provider-safe capacity.
    return providerSpeechWindowSeconds(Math.max(bounds.minSeconds, Math.min(bounds.maxSeconds, authored || deterministic)));
  });
  const authoredWindows = turns.map(turn => ({
    start: Number(turn?.start ?? turn?.startSecond),
    end: Number(turn?.end ?? turn?.endSecond)
  }));
  // Editors commonly author the first line from 0.0. The provider contract
  // still needs a 0.25-second closed-mouth clean-onset window, so validate and
  // serialize the effective (clamped) start instead of discarding the entire
  // authored end time and rebuilding an unrelated schedule.
  const effectiveAuthoredWindows = authoredWindows.map(window => ({
    start: Number.isFinite(window.start) ? Math.max(0.30, window.start) : window.start,
    end: Number.isFinite(window.end) ? Math.min(duration - 0.35, window.end) : window.end
  }));
  const hasAuthoredWindows = authoredWindows.some(window => Number.isFinite(window.start) && Number.isFinite(window.end));
  const authoredTimingAdequate = hasAuthoredWindows && effectiveAuthoredWindows.every((window, index) => (
    Number.isFinite(window.start)
    && Number.isFinite(window.end)
    && window.start >= 0.30
    && window.end <= duration - 0.35
    && window.end - window.start + 0.02 >= speechBounds[index].minSeconds
    && (!hasEditorialTiming || window.end - window.start - 0.05 <= speechBounds[index].maxSeconds)
    && (index === 0 || window.start + 0.05 >= effectiveAuthoredWindows[index - 1].end)
  ));
  // Authored subshot timestamps are camera/edit hints, not a licence to cut a
  // spoken sentence short. If any authored window is too narrow, use the full
  // clip for the ordered dialogue plan and let the physical action/reaction run
  // concurrently. This changes prompt guidance only; it never rejects or
  // rewrites the user's dialogue and never triggers a paid retry.
  // Editorial performance timing is the highest-authority clock. Camera take
  // windows describe framing envelopes and may legitimately contain several
  // consecutive lines, so they must never override the Agent's per-line
  // speech/breath/reaction decisions.
  if (authoredTimingAdequate) {
    const slots = effectiveAuthoredWindows.map((window, index) => ({
      start: window.start,
      end: window.end,
      requiredSeconds: required[index],
      afterBeatSeconds: Number.isFinite(plannedAfterBeats[index]) && plannedAfterBeats[index] >= 0
        ? plannedAfterBeats[index]
        : 0
    }));
    const lastEnd = Math.max(0, ...slots.map(slot => slot.end + slot.afterBeatSeconds));
    return {
      duration,
      reactionTail: Math.max(0, duration - Math.min(duration, lastEnd)),
      speechSpan: Math.min(duration, lastEnd),
      requiredSpeechSeconds: required.reduce((sum, value) => sum + value, 0),
      recommendedDuration: duration,
      overflow: false,
      overflowSeconds: 0,
      authoredTimingAdequate: true,
      editorialTiming: hasEditorialTiming,
      slots
    };
  }
  if (hasEditorialTiming) {
    const editorialTotal = required.reduce((sum, value, index) => sum + value
      + (Number.isFinite(plannedAfterBeats[index]) && plannedAfterBeats[index] >= 0 ? plannedAfterBeats[index] : 0), 0);
    // Editorial speech durations are authoritative, but the otherwise free
    // action time must not all collect after the final syllable.  Give the
    // opening action a short lead-in, distribute the remaining breathing room
    // across actual speaker changes, and keep the final reaction bounded.  The
    // dialogue text and speech seconds remain untouched; this only schedules
    // authored action/reaction around them.
    const slack = Math.max(0, duration - editorialTotal);
    const desiredTail = Math.min(turns.length <= 1 ? 3 : 2.6, slack * (turns.length <= 1 ? 0.6 : 0.4));
    const leadAndTransition = Math.max(0, slack - desiredTail);
    // Preserve a visible entrance/setup beat instead of forcing every line to
    // begin immediately after the technical 0.25-second onset guard. Keep the
    // remainder available for motivated speaker-change reactions.
    const leadIn = Math.max(0.30, Math.min(
      turns.length <= 1 ? 1.7 : 1.5,
      leadAndTransition * (turns.length <= 1 ? 1 : 0.42)
    ));
    const transitionCount = Math.max(0, turns.length - 1);
    const transitionExtra = transitionCount > 0
      ? Math.max(0, leadAndTransition - leadIn) / transitionCount
      : 0;
    let cursor = leadIn;
    const slots = required.map((speechSeconds, index) => {
      const start = cursor;
      const end = Math.min(duration, start + speechSeconds);
      const afterBeat = Number.isFinite(plannedAfterBeats[index]) && plannedAfterBeats[index] >= 0
        ? plannedAfterBeats[index]
        : 0;
      cursor = Math.min(duration, end + afterBeat + (index < turns.length - 1 ? transitionExtra : 0));
      return { start, end, requiredSeconds: speechSeconds, afterBeatSeconds: afterBeat };
    });
    return {
      duration,
      reactionTail: Math.max(0, duration - Math.min(duration, cursor)),
      speechSpan: Math.min(duration, cursor),
      requiredSpeechSeconds: required.reduce((sum, value) => sum + value, 0),
      recommendedDuration: Math.max(duration, Math.ceil(editorialTotal)),
      overflow: editorialTotal > duration + 0.05,
      overflowSeconds: Math.max(0, editorialTotal - duration),
      authoredTimingAdequate: false,
      editorialTiming: true,
      slots
    };
  }
  const requiredSpeechSeconds = required.reduce((sum, value) => sum + value, 0);
  // Natural speech owns only the time it actually needs.  The previous
  // allocator gave the final line every unused second in the clip, so a short
  // seven-character reply could be labelled as a 10.8-second utterance.  That
  // encouraged H3 to stretch or repeat speech and starved the authored action,
  // reaction and camera coverage.  Compress only when the written dialogue
  // genuinely exceeds the clip; otherwise leave all remaining time as a
  // silent physical-story tail.
  const cleanLeadSeconds = 0.30;
  const cleanTailSeconds = 0.35;
  const availableSpeechSeconds = Math.max(0.2, duration - cleanLeadSeconds - cleanTailSeconds);
  const scale = requiredSpeechSeconds > 0 ? Math.min(1, availableSpeechSeconds / requiredSpeechSeconds) : 1;
  let cursor = cleanLeadSeconds;
  const slots = required.map(requiredSeconds => {
    const start = cursor;
    const remaining = Math.max(0, duration - cursor);
    const seconds = Math.min(remaining, requiredSeconds * scale);
    cursor += seconds;
    return { start, end: cursor, requiredSeconds };
  });
  const speechSpan = Math.min(duration, cursor);
  const reactionTail = Math.max(0, duration - speechSpan);
  return {
    duration,
    reactionTail,
    speechSpan,
    requiredSpeechSeconds,
    recommendedDuration: Math.max(duration, Math.ceil(requiredSpeechSeconds + reactionTail)),
    overflow: requiredSpeechSeconds > Math.max(0, speechSpan - cleanLeadSeconds) + 0.05,
    overflowSeconds: Math.max(0, requiredSpeechSeconds - Math.max(0, speechSpan - cleanLeadSeconds)),
    authoredTimingAdequate,
    editorialTiming: false,
    slots
  };
}

function referenceBindings(references = {}, characterIds = [], dialogueTurns = [], project = {}, shot = {}) {
  const definitions = [];
  const retention = [];
  const subjects = new Map();
  const subjectClauses = new Map();
  const subjectKinds = new Map();
  const directDefinitions = [];
  const imageRoles = list(references?.imageRoles);
  const wardrobeOwnerIds = new Set(imageRoles
    .filter(role => clean(role?.type) === "wardrobe")
    .map(role => clean(role?.characterId || role?.ownerId))
    .filter(Boolean));
  const referencedCharacterIds = new Set(imageRoles
    .filter(role => clean(role?.type) === "character")
    .map(role => clean(role?.entityId || role?.characterId))
    .filter(Boolean));
  const speakerIds = unique(list(dialogueTurns).map(turn => clean(turn?.speakerId || turn?.speaker)));
  const audioCharacterIds = new Set(list(references?.audios)
    .map(item => clean(item?.characterId || item?.characterName))
    .filter(Boolean));
  const boundCharacterIds = new Set([...referencedCharacterIds, ...speakerIds, ...audioCharacterIds]);
  const authoredCharacterIds = unique(list(characterIds).map(clean).filter(Boolean));
  const nativeFrames = ["text_to_video", "image_to_video"].includes(references.hailuoApiMode);
  if (nativeFrames) for (const id of authoredCharacterIds) boundCharacterIds.add(id);
  const backgroundAliasByCharacterId = new Map();
  const visibleIds = new Set(list(shot.visibleCharacterIds));
  const remoteListeners = new Set(list(dialogueTurns)
    .filter(turn => turn.addressMode === 'offscreen')
    .flatMap(turn => list(turn.listenerIds))
    .map(clean).filter(id => id && !visibleIds.has(id) && !boundCharacterIds.has(id)));
  authoredCharacterIds
    .filter(id => !boundCharacterIds.has(id) && !remoteListeners.has(id))
    .forEach(id => backgroundAliasByCharacterId.set(
      id,
      // Missing media binding says nothing about the actor's identity,
      // visibility or performance. Preserve the source identity without
      // manufacturing a Picture, Subject, voice or anonymous extra.
      `the source-identified character ${id}`
    ));
  // An explicitly remote addressee is a narrative identity, not a visible extra.
  // No portrait, Subject or voice is invented for this silent recipient.
  for (const id of remoteListeners) backgroundAliasByCharacterId.set(id,
    `the off-screen addressee ${id} (outside this frame)`);
  const cueAliases = new Map(backgroundAliasByCharacterId);
  for (const character of list(project?.characters)) {
    const id = clean(character?.id);
    const alias = backgroundAliasByCharacterId.get(id);
    const name = clean(character?.name);
    if (alias && name) cueAliases.set(name, alias);
  }
  const referencedPropIds = new Set(imageRoles
    .filter(role => clean(role?.type) === "prop")
    .map(role => clean(role?.entityId || role?.propId))
    .filter(Boolean));
  list(project?.assetLibraries?.props).forEach((prop, index) => {
    const id = clean(prop?.id);
    if (!id || referencedPropIds.has(id)) return;
    // An incidental object may legitimately have no image asset. Keep its
    // source-grounded appearance instead of inventing an opaque alphabetic
    // identity. This is a textual description, never an extra Picture input.
    const label = clean(prop?.nameEn || prop?.referenceLabelEn);
    const description = clean(prop?.descriptionEn).split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    const noun = description.match(/^(?:A|An|The)\s+(.+?)\s+(?:is|are|was|were|has|have|measures?|forms?|contains?|remains?)\b/i)?.[1];
    const grounded = [label, noun].find(value => value && /[A-Za-z]/.test(value) && !/[\u3400-\u9fff]/.test(value));
    const alias = grounded
      ? `the ${grounded.replace(/^(?:the|an?)\s+/i, "")}`
      : description && !/[\u3400-\u9fff]/.test(description)
        ? `the existing continuity object (source appearance: ${description.replace(/[.!?]$/, "")})`
      : id;
    cueAliases.set(id, alias);
    const name = clean(prop?.name);
    if (name) cueAliases.set(name, alias);
  });
  let subjectIndex = 0;
  const ensureSubject = id => {
    const key = clean(id);
    if (!key) return "";
    if (backgroundAliasByCharacterId.has(key)) return backgroundAliasByCharacterId.get(key);
    if (!subjects.has(key)) subjects.set(key, `<Subject ${++subjectIndex}>`);
    return subjects.get(key);
  };
  const addSubjectClause = (subject, clause) => {
    if (!subject || !clause) return;
    const values = subjectClauses.get(subject) || [];
    values.push(clause);
    subjectClauses.set(subject, unique(values));
  };
  const speakerByCharacterId = new Map();
  speakerIds.forEach((id, index) => {
    ensureSubject(id);
    // MiniMax H3 assigns Sx once by the order of actual vocal events in this
    // target video.  C02 is an internal identity and must not become S2 merely
    // because its database id ends in 02.
    speakerByCharacterId.set(id, `S${index + 1}`);
  });
  authoredCharacterIds.filter(id => boundCharacterIds.has(id)).forEach(id => {
    const subject = ensureSubject(id);
    subjectKinds.set(subject, "character");
    addSubjectClause(subject, `the recurring character ${providerStableId(id, `character${subjects.size}`)}`);
  });
  speakerIds.forEach(id => {
    const subject = ensureSubject(id);
    subjectKinds.set(subject, "character");
    addSubjectClause(subject, `the recurring character ${providerStableId(id, `speaker${speakerIds.indexOf(id) + 1}`)}`);
  });

  const images = list(references?.images);
  const imageCount = Math.max(images.length, imageRoles.length);
  for (let index = 0; index < imageCount; index += 1) {
    const role = imageRoles[index] || {};
    const picture = `<Picture ${index + 1}>`;
    const type = clean(role?.type);
    const entityId = clean(role?.entityId || role?.characterId || role?.sceneId || role?.productId || role?.propId || role?.wardrobeId);
    if (type === "character") {
      const subject = ensureSubject(entityId || `character-reference-${index + 1}`);
      subjectKinds.set(subject, "character");
      // Every supplied identity picture needs its stable owner, including a
      // continuity-only character absent from this camera unit. The visible
      // cast and speaker loops above do not cover those reference owners.
      addSubjectClause(subject, `the recurring character ${providerStableId(entityId, `character-reference-${index + 1}`)}`);
      addSubjectClause(subject, wardrobeOwnerIds.has(entityId)
        ? `exact face, age, body and immutable identity come from ${picture}; hair and wardrobe follow the dedicated current appearance reference`
        : `exact face, age, body and identity from ${picture}; hair/wardrobe change only as authored`);
    } else if (type === "scene") {
      const subject = ensureSubject(`scene:${entityId || index + 1}`);
      subjectKinds.set(subject, "scene");
      addSubjectClause(subject, `location ${providerStableId(entityId, `scene${index + 1}`)}: fixed architecture, furniture and geometry from ${picture}; time of day, lighting, movable objects and viewing direction follow the current authored shot`);
    } else if (type === "product") {
      const subject = ensureSubject(`product:${entityId || index + 1}`);
      subjectKinds.set(subject, "product");
      addSubjectClause(subject, `the recurring product ${providerStableId(entityId, `product${index + 1}`)} whose exact package, color, proportions, and scale come from ${picture}`);
    } else if (type === "prop") {
      const subject = ensureSubject(`prop:${entityId || index + 1}`);
      subjectKinds.set(subject, "prop");
      addSubjectClause(subject, `prop ${providerStableId(entityId, `prop${index + 1}`)}: exact appearance/scale from ${picture}; holder/state follow authored actions`);
    } else if (type === "wardrobe") {
      const ownerId = clean(role?.characterId || role?.ownerId || role?.entityId);
      const subject = ownerId && subjects.has(ownerId)
        ? ensureSubject(ownerId)
        : ensureSubject(`wardrobe:${entityId || index + 1}`);
      if (!subjectKinds.has(subject)) subjectKinds.set(subject, "wardrobe");
      addSubjectClause(subject, `the exact complete wardrobe and accessories shown in ${picture}`);
    } else if (type === "storyboard_start") {
      directDefinitions.push(`${picture} is the exact before-action narrative frame at 0.00 seconds, preserving set, props, blocking, lighting, and camera axis.`);
    } else if (type === "storyboard_end") {
      directDefinitions.push(`${picture} is the exact final narrative state after the authored action completes.`);
    } else if (type === "storyboard_timeline_panel") {
      const panelNumber = Math.max(1, Number(role?.panelIndex) + 1 || Number(role?.sequenceIndex) || index + 1);
      const start = Number.isFinite(Number(role?.startSecond)) ? Number(role.startSecond) : Math.max(0, panelNumber - 1);
      const end = Number.isFinite(Number(role?.endSecond)) ? Number(role.endSecond) : start + 1;
      directDefinitions.push(`${picture} is ordered 9:16 narrative frame P${String(panelNumber).padStart(2, "0")} for ${timestamp(start, true)}-${timestamp(end, true)} seconds.`);
    } else if (["storyboard_generation_block_sheet", "storyboard_take_sheet", "storyboard_sheet", "storyboard_panel_anchor"].includes(type)) {
      directDefinitions.push(`${picture} supplies ordered narrative frame composition and physical state for the authored timeline.`);
    } else {
      directDefinitions.push(`${picture} is a relevant visual reference for this clip.`);
    }
  }

  const audioEntries = list(references?.audios).map((item, index) => {
    const fallbackSpeakerId = speakerIds[index] || clean(characterIds[index]);
    const id = clean(item?.characterId) || fallbackSpeakerId || clean(item?.characterName);
    return { item, index, id, subject: ensureSubject(id) };
  });
  const subjectEntries = [...subjects.entries()];
  for (const [entryIndex, [id, subject]] of subjectEntries.entries()) {
    const clauses = subjectClauses.get(subject) || [`the recurring authored subject ${providerStableId(id, `subject${entryIndex + 1}`)}`];
    const speaker = speakerByCharacterId.get(id);
    definitions.push(`${subject}${speaker ? ` (${speaker})` : ""} is ${clauses.join("; ")}.`);
    const kind = subjectKinds.get(subject) || "subject";
    const subjectTurns = list(dialogueTurns).filter(turn => clean(turn?.speakerId || turn?.speaker) === id);
    const voiceOnly = subjectTurns.length > 0 && subjectTurns.every(turn => turn?.onScreen === false);
    // A voice-only owner still needs an Sx binding, but a missing identity
    // image cannot require preserving a visible body, face or wardrobe.
    // Actual voice references retain their own Audio relationship below.
    if (kind === "character" && voiceOnly && !referencedCharacterIds.has(id)) continue;
    const preservation = kind === "scene"
      ? "fixed architecture, furniture, geometry and scale remain stable; current authored time, lighting, object states and camera beats take precedence"
      : kind === "product"
        ? "package, printing, color, proportions, and scale remain stable; holder, hand, support, and physical state follow the authored action timeline"
        : kind === "prop"
          ? "stable appearance/scale; only authored holder/state changes"
          : kind === "wardrobe"
            ? "garment shape, fabric, color, accessories, and wearer continuity remain stable"
            : wardrobeOwnerIds.has(id)
              ? "identity, age, body, and role remain stable; hair and wardrobe follow the dedicated current appearance reference"
              : "identity, age, body, and role remain stable; hair and wardrobe remain at the current authored state";
    // Official full-reference syntax does not place (Sx) in retention_analysis.
    retention.push(`${subject}: fully_preserved - ${preservation}.`);
  }
  definitions.push(...directDefinitions);
  directDefinitions.forEach(line => {
    const token = line.match(/^<Picture \d+>/)?.[0];
    if (!token) return;
    const index = Number(token.match(/\d+/)[0]) - 1;
    const role = list(references?.imageRoles)[index] || {};
    const type = clean(role.type);
    const scope = type === "storyboard_end"
      ? "preserve this exact completed composition and physical state only at the final frame; reach it through the authored actions, never use it as the opening or freeze it throughout"
      : type === "storyboard_start"
        ? "preserve this exact before-action composition and physical state only at the opening; subsequent states follow the authored actions"
        : type === "storyboard_timeline_panel"
          ? "preserve the authored composition and physical state only during this frame's defined timeline interval, not before or after it"
          : "preserve only the authored composition, spatial state, and continuity role at its defined point in the timeline";
    retention.push(`${token}: fully_preserved - ${scope}.`);
  });

  const videos = list(references?.videos).length ? list(references.videos) : (references?.video ? [references.video] : []);
  videos.forEach((_item, index) => {
    const role = list(references?.videoRoles)[index] || {};
    definitions.push(role?.type === "previous_shot"
      ? `<Video ${index + 1}> supplies only the exact final temporal state from which this clip continues.`
      : `<Video ${index + 1}> supplies motion, camera rhythm, and blocking reference for this clip.`);
    retention.push(role?.type === "previous_shot"
      ? `<Video ${index + 1}>: fully_preserved - preserve its defined final temporal starting state; continue the authored actions without replaying the source clip.`
      : `<Video ${index + 1}>: weak_reference - follow the selected motion, camera rhythm and blocking guidance without copying the source clip.`);
  });

  const audioByCharacterId = new Map();
  audioEntries.forEach(({ index, id, subject }) => {
    const audio = `<Audio ${index + 1}>`;
    if (id) audioByCharacterId.set(id, audio);
    const speaker = speakerByCharacterId.get(id);
    definitions.push(`${audio} is the voice-timbre reference for ${subject || "the assigned speaker"}${speaker ? ` (${speaker})` : ""}; use only its vocal identity and do not repeat its source utterance.`);
    retention.push(`${audio}: reference - preserve vocal identity while speaking only the authored dialogue in this prompt.`);
  });
  return {
    definitions,
    retention,
    subjects,
    subjectKinds,
    speakerByCharacterId,
    audioByCharacterId,
    backgroundAliasByCharacterId,
    cueAliases,
    ensureSubject
  };
}

function regexEscape(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The H3 reference protocol assigns visual identity to <Subject N>, not to our
 * internal C01/P01/W01 database ids. Keep the ids in subject_definitions for
 * traceability, but rewrite every production cue to the official subject and
 * picture tokens so the model cannot invent a second unbound person/object.
 */
function bindProviderCueSubjects(value, bindings = {}, references = {}) {
  let output = clean(value);
  if (!output) return output;
  // Bind silent direction only. Names, common words and even literal asset IDs
  // inside the source dialogue are speech, never replaceable reference aliases.
  if (/<d>[\s\S]*?<\/d>/i.test(output)) {
    return output.split(/(<d>[\s\S]*?<\/d>)/gi).map(part => {
      if (/^<d>/i.test(part) || !part.trim()) return part;
      return part.replace(part.trim(), () => bindProviderCueSubjects(part.trim(), bindings, references));
    }).join("");
  }
  const roles = list(references?.imageRoles);
  const replaceAlias = (source, alias, replacement) => {
    const raw = clean(alias);
    if (!raw || !replacement) return source;
    const pattern = /^[A-Za-z0-9_-]+$/.test(raw)
      ? new RegExp(`\\b${regexEscape(raw)}\\b`, "g")
      : new RegExp(regexEscape(raw), "g");
    return source.replace(pattern, replacement);
  };

  for (const [alias, replacement] of bindings?.cueAliases || []) {
    output = replaceAlias(output, alias, replacement);
  }

  // A wardrobe reference is an appearance state for its wearer, not a second
  // person-like subject. Express an authored change as an editorial reveal;
  // asking a video model to morph C01 into W01 caused identity/garment drift.
  roles.forEach((role, index) => {
    if (clean(role?.type) !== "wardrobe") return;
    const wardrobeId = clean(role?.entityId || role?.wardrobeId);
    const ownerId = clean(role?.characterId || role?.ownerId);
    const ownerSubject = bindings?.subjects?.get(ownerId) || "the authored wearer";
    const picture = `<Picture ${index + 1}>`;
    if (ownerId && wardrobeId) {
      const changePattern = new RegExp(`\\b${regexEscape(ownerId)}\\s+changes?\\s+into\\s+${regexEscape(wardrobeId)}\\b`, "gi");
      output = output.replace(changePattern, `a direct cut reveals ${ownerSubject} already wearing the exact complete wardrobe shown in ${picture}`);
    }
    if (wardrobeId) {
      output = output.replace(new RegExp(`\\b${regexEscape(wardrobeId)}\\b`, "g"), `the exact complete wardrobe shown in ${picture}`);
    }
  });

  const aliases = [];
  for (const [key, subject] of bindings?.subjects || []) {
    const raw = clean(key);
    if (!raw || !subject) continue;
    if (!raw.includes(":")) aliases.push([raw, subject]);
    else {
      const [kind, ...rest] = raw.split(":");
      const alias = rest.join(":");
      // "product" is ordinary English and must not be replaced globally.
      if (alias && !(kind === "product" && alias.toLowerCase() === "product")) aliases.push([alias, subject]);
    }
  }
  aliases
    .sort((left, right) => right[0].length - left[0].length)
    .forEach(([alias, subject]) => {
      output = replaceAlias(output, alias, subject);
    });

  const productSubjects = roles.map(role => {
    if (clean(role?.type) !== "product") return "";
    const entityId = clean(role?.entityId || role?.productId);
    return bindings?.subjects?.get(`product:${entityId}`) || "";
  }).filter(Boolean);
  if (productSubjects.length === 1) {
    const productSubject = productSubjects[0];
    output = output
      .replace(/\bone\s+product\s+sachet\b/gi, `one individual hand-sized flat sachet of ${productSubject}`)
      .replace(/\bone\s+sachet\b(?!\s+of\s+<Subject\s+\d+>)/gi, `one individual hand-sized flat sachet of ${productSubject}`);
  }

  // Resolve a common historical translation ambiguity: after another subject
  // adjusts "its collar", the possessive often points to the wardrobe wearer,
  // not the acting helper. The bound wardrobe owner supplies that authority.
  roles.forEach(role => {
    if (clean(role?.type) !== "wardrobe") return;
    const owner = bindings?.subjects?.get(clean(role?.characterId || role?.ownerId));
    if (!owner) return;
    output = output.replace(
      /(<Subject\s+\d+>)\s+(straightens|adjusts|fixes|smooths)\s+(?:its|his|her)\s+(collar|sleeve|lapel|dress|jacket|coat)\b/gi,
      (match, actor, verb, garmentPart) => actor === owner ? match : `${actor} ${verb} ${owner}'s ${garmentPart}`
    );
  });
  return output;
}

function providerReferenceContext(bindings = {}, references = {}) {
  const statements = [];
  list(references?.imageRoles).forEach((role, index) => {
    const type = clean(role?.type);
    const entityId = clean(role?.entityId || role?.sceneId || role?.productId || role?.propId || role?.wardrobeId);
    const picture = `<Picture ${index + 1}>`;
    if (type === "scene") {
      const subject = bindings?.subjects?.get(`scene:${entityId}`);
      if (subject) statements.push(`The entire clip takes place inside ${subject}.`);
    } else if (type === "product") {
      const subject = bindings?.subjects?.get(`product:${entityId}`);
      if (subject) statements.push(`Every authored product package or sachet handled in the action is ${subject}.`);
    } else if (type === "wardrobe") {
      const owner = bindings?.subjects?.get(clean(role?.characterId || role?.ownerId));
      if (owner) statements.push(`${owner} wears the exact complete wardrobe shown in ${picture}.`);
    }
  });
  return unique(statements).join(" ");
}

function specDirections(spec = {}, shot = {}) {
  const directions = [];
  const add = value => {
    const english = metadataCue(value, "", 120);
    if (english) directions.push(english);
  };
  add(englishOnly(shot?.providerVisualEn, "", 160));
  add(englishOnly(shot?.providerCameraEn, "", 160));
  list(shot?.providerDirectionsEn).forEach(value => add(englishOnly(value, "", 120)));
  add(englishOnly(shot?.providerPerformanceEn, "", 120));
  add(productionCue([shot?.cameraMove, shot?.compositionPlan, shot?.shotSize].filter(Boolean).join(" "), "camera", "", 100));
  add(spec?.summaryEn);
  list(spec?.subshots).forEach(item => {
    add(item?.visualEn);
    add(item?.cameraEn);
    add(item?.performanceEn);
    add(item?.listenerReactionEn);
  });
  return unique(directions).slice(0, 2);
}

function timedRange(item = {}, index = 0, count = 1, duration = 10) {
  const authoredStart = Number(item?.start ?? item?.startSecond);
  const authoredEnd = Number(item?.end ?? item?.endSecond);
  const fallbackStart = duration * index / Math.max(1, count);
  const fallbackEnd = duration * (index + 1) / Math.max(1, count);
  const start = Number.isFinite(authoredStart) ? Math.max(0, Math.min(duration, authoredStart)) : fallbackStart;
  const end = Number.isFinite(authoredEnd) && authoredEnd > start
    ? Math.max(start, Math.min(duration, authoredEnd))
    : fallbackEnd;
  return { start, end };
}

function hasSpeakerChange(turns = [], start = 0, end = Infinity) {
  const speakers = list(turns)
    .filter(turn => {
      const turnStart = Number(turn?.start ?? turn?.startSecond);
      const turnEnd = Number(turn?.end ?? turn?.endSecond);
      if (!Number.isFinite(turnStart) || !Number.isFinite(turnEnd)) return true;
      return turnEnd > start && turnStart < end;
    })
    .map(turn => clean(turn?.speakerId || turn?.speaker))
    .filter(Boolean);
  return speakers.some((speaker, index) => index > 0 && speaker !== speakers[index - 1]);
}

function timedVisualSegments(spec = {}, shot = {}, turns = [], duration = 10) {
  const providerSegments = list(shot?.providerTimedDirections);
  const specSegments = list(spec?.subshots);
  const authoredSegments = list(shot?.subshots);
  const source = providerSegments.length
    ? providerSegments
    : specSegments.length
      ? specSegments
      : authoredSegments.length
        ? authoredSegments
        : [shot];
  const globalDirections = specDirections(spec, shot);
  const segmentCount = source.length;
  const compact = segmentCount >= 3 || list(turns).length >= 4;
  const segmentSpeakers = source.map(item => clean(item?.speakerId)).filter(Boolean);
  const sequenceHasSpeakerChange = segmentSpeakers.some((speaker, index) => index > 0 && speaker !== segmentSpeakers[index - 1]);
  return source.map((item, index) => {
    const range = timedRange(item, index, segmentCount, duration);
    const speakerCut = sequenceHasSpeakerChange || hasSpeakerChange(turns, range.start, range.end);
    // For a legacy single-segment shot, the shot-level authored action is more
    // specific than a generic synthesized subshot placeholder. ID-aware
    // providerTimedDirections remain authoritative when present.
    const singleLegacyMasterAction = segmentCount === 1 && !providerSegments.length
      ? shot?.actionEn || shot?.visualBeatEn || shot?.action
      : "";
    const actionSource = singleLegacyMasterAction
        || item?.visualEn || item?.actionEn || item?.providerVisualEn
        || (segmentCount === 1 ? shot?.actionEn || shot?.visualBeatEn || shot?.action : "")
        || globalDirections[0];
    const action = deterministicEnglishCue(
      actionSource,
      "action",
      "advance the authored causal action to a visible change",
      compact ? 260 : 360
    );
    const cameraSource = item?.cameraEn || item?.providerCameraEn || item?.framingEn
        || (segmentCount === 1 ? shot?.providerCameraEn || shot?.cameraMoveEn || shot?.shotSizeEn : "");
    let camera = deterministicEnglishCue(
      cameraSource,
      "camera",
      speakerCut
        ? "hard cut on each speaker change in shot-reverse-shot framing"
        : "hold the authored framing on the active story beat",
      compact ? 130 : 160
    );
    const before = deterministicEnglishCue(
      item?.stateBeforeEn || (index === 0 ? shot?.stateBeforeEn || shot?.stateBefore : ""),
      "state",
      index === 0 ? "opening pose and prop state" : "prior exact end state",
      180
    );
    const after = deterministicEnglishCue(
      item?.stateAfterEn || (index === segmentCount - 1 ? shot?.stateAfterEn || shot?.stateAfter : ""),
      "state",
      index === segmentCount - 1 ? "authored completed state" : "next authored state",
      180
    );
    // Concrete causal foley is more important than saving a few prompt bytes.
    // The old 100-character compact cap routinely cut off the final (and often
    // most important) sound, such as a product box touching the washbasin.
    const segmentSound = deterministicEnglishCue(item?.soundEn || item?.sound, "sound", "", 3000);
    const masterSound = deterministicEnglishCue(shot?.soundEn || shot?.audioPlan || shot?.soundDesign, "sound", "", 3000);
    const sound = unique([segmentSound, masterSound]).join("; then ");
    const blocking = metadataCue(
      item?.blockingEn || item?.positionEn || item?.screenDirectionEn || item?.eyelineEn,
      "",
      260
    );
    const backgroundAction = deterministicEnglishCue(
      item?.backgroundActionEn || item?.ensembleActionEn || item?.listenerReactionEn || item?.backgroundAction,
      "action",
      "",
      260
    );
    return {
      ...range,
      action,
      framing: metadataCue(item?.framingEn || item?.providerFramingEn, "", 200),
      camera,
      before,
      after,
      sound,
      blocking,
      backgroundAction,
      speakerCut,
      // Keep the authoritative Chinese half of the semantic compiler beside
      // the legacy English execution mirror.  The integrated Chinese timeline
      // is now the provider payload itself, so dropping these fields here would
      // silently fall back to the shorter pre-compile subshot summary.
      actionZh: clean(item?.actionZh || (/[㐀-鿿]/.test(clean(item?.action || item?.visualBeat)) ? (item?.action || item?.visualBeat) : "")
        || (segmentCount === 1 && /[㐀-鿿]/.test(clean(shot?.action || shot?.visualBeat)) ? (shot?.action || shot?.visualBeat) : "")),
      framingZh: clean(item?.framingZh || (/[㐀-鿿]/.test(clean(item?.framing || item?.shotType)) ? (item?.framing || item?.shotType) : "")),
      cameraZh: clean(item?.cameraZh || (/[㐀-鿿]/.test(clean(item?.camera || item?.cameraMove)) ? (item?.camera || item?.cameraMove) : "")),
      blockingZh: clean(item?.blockingZh || (/[㐀-鿿]/.test(clean(item?.blocking || item?.position || item?.eyelineDirection)) ? (item?.blocking || item?.position || item?.eyelineDirection) : "")),
      backgroundActionZh: clean(item?.backgroundActionZh || (/[㐀-鿿]/.test(clean(item?.backgroundAction || item?.ensembleAction || item?.listenerReaction)) ? (item?.backgroundAction || item?.ensembleAction || item?.listenerReaction) : "")),
      stateBeforeZh: clean(item?.stateBeforeZh || (/[㐀-鿿]/.test(clean(item?.stateBefore)) ? item?.stateBefore : "")),
      stateAfterZh: clean(item?.stateAfterZh || (/[㐀-鿿]/.test(clean(item?.stateAfter)) ? item?.stateAfter : "")),
      soundZh: clean(item?.soundZh || (/[㐀-鿿]/.test(clean(item?.sound)) ? item?.sound : ""))
    };
  });
}

function inferredDialogueWindowsFromAuthoredSegments(project = {}, shot = {}, turns = [], segments = [], timing = {}, duration = 10) {
  const dialogueTurns = list(turns);
  const visualSegments = list(segments);
  if (!dialogueTurns.length || !visualSegments.length) return { used: false, windows: [] };
  // Explicit editorial timecodes remain authoritative. This inference is only
  // for legacy/free-form scripts whose dialogue has speaker ownership but no
  // clock. Mixing inferred and explicit clocks would make their order unclear.
  if (dialogueTurns.some(turn => Number.isFinite(Number(turn?.start ?? turn?.startSecond))
    || Number.isFinite(Number(turn?.end ?? turn?.endSecond)))) {
    return { used: false, windows: [] };
  }
  const assignments = [];
  let minimumSegmentIndex = 0;
  for (let turnIndex = 0; turnIndex < dialogueTurns.length; turnIndex += 1) {
    const turn = dialogueTurns[turnIndex] || {};
    const speakerId = clean(turn?.speakerId || turn?.speaker);
    const speaker = integratedCharacter(project, speakerId);
    const dialogueId = clean(turn?.sourceDialogueId);
    const exactText = clean(turn?.text || turn?.spokenText);
    const candidates = visualSegments.map((segment, segmentIndex) => {
      if (segmentIndex < minimumSegmentIndex) return { segmentIndex, score: -1 };
      const sourceIndex = Number.isInteger(Number(segment?.timelineSourceIndex))
        ? Number(segment.timelineSourceIndex)
        : segmentIndex;
      const source = list(shot?.subshots)[sourceIndex] || segment || {};
      const sourceDialogueIds = unique([
        ...list(source?.sourceDialogueIds),
        ...list(source?.dialogueIds),
        ...list(source?.dialogueTurns).map(item => item?.sourceDialogueId)
      ]);
      const sourceSpeakers = unique([
        source?.speakerId,
        ...list(source?.speakerIds),
        ...list(source?.dialogueTurns).map(item => item?.speakerId || item?.speaker)
      ]);
      const sourceDialogueText = clean([
        source?.dialogue,
        ...list(source?.dialogueTurns).map(item => item?.text || item?.spokenText)
      ].join(" "));
      const chineseAction = clean(source?.actionZh || source?.action || source?.visualBeat);
      const englishAction = clean(source?.actionEn || source?.visualEn || segment?.action);
      let score = 0;
      if (dialogueId && sourceDialogueIds.includes(dialogueId)) score += 120;
      if (sourceSpeakers.includes(speakerId) || sourceSpeakers.includes(speaker.name)) score += 100;
      if (exactText && sourceDialogueText.includes(exactText)) score += 100;
      const speakerPattern = regexEscape(speaker.name || speakerId);
      if (speakerPattern && new RegExp(`(?:^|[。；;])[^。；;]{0,24}${speakerPattern}[^。；;]{0,12}(?:回应|回答|答道|说道|说出|开口|发问|追问|质问|宣布|喊)`).test(chineseAction)) score += 55;
      const idPattern = regexEscape(speakerId);
      if (idPattern && new RegExp(`(?:^|[.;])\\s*${idPattern}\\b[^.;]{0,90}\\b(?:says?|states?|answers?|repl(?:y|ies)|asks?|declares?|speaks?)\\b`, "i").test(englishAction)) score += 55;
      if (turnIndex === 0 && segmentIndex === 0) score += 4;
      return { segmentIndex, score };
    }).filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.segmentIndex - right.segmentIndex);
    if (!candidates.length) return { used: false, windows: [] };
    const selected = candidates[0].segmentIndex;
    assignments.push(selected);
    minimumSegmentIndex = selected;
  }
  // A single all-purpose visual segment has no competing authored camera beat
  // to protect. Keep the ordinary natural dialogue allocator so the first
  // line may begin at 00:00.000 and the remaining time stays available for
  // physical action. Segment inference is only needed to prevent dialogue
  // from crossing into a different authored visual beat.
  if (visualSegments.length === 1 && new Set(assignments).size === 1) {
    return { used: false, windows: [] };
  }

  const windows = new Array(dialogueTurns.length);
  const grouped = new Map();
  assignments.forEach((segmentIndex, turnIndex) => {
    if (!grouped.has(segmentIndex)) grouped.set(segmentIndex, []);
    grouped.get(segmentIndex).push(turnIndex);
  });
  for (const [segmentIndex, turnIndices] of grouped.entries()) {
    const segment = visualSegments[segmentIndex] || {};
    const segmentStart = Math.max(0, Number(segment?.start) || 0);
    const segmentEnd = Math.min(duration, Number(segment?.end) || duration);
    const segmentSeconds = Math.max(0, segmentEnd - segmentStart);
    const gapSeconds = turnIndices.length > 1 ? 0.15 * (turnIndices.length - 1) : 0;
    const requiredSeconds = turnIndices.map(index => Math.max(0.25, Number(timing?.slots?.[index]?.requiredSeconds)
      || (Number(timing?.slots?.[index]?.end) - Number(timing?.slots?.[index]?.start))
      || 0.8));
    const requiredTotal = requiredSeconds.reduce((sum, value) => sum + value, 0) + gapSeconds;
    if (requiredTotal > segmentSeconds + 0.05) return { used: false, windows: [] };
    const slack = Math.max(0, segmentSeconds - requiredTotal);
    let cursor = segmentStart + Math.min(0.5, slack / 2);
    turnIndices.forEach((turnIndex, groupIndex) => {
      const start = cursor;
      const end = Math.min(segmentEnd, start + requiredSeconds[groupIndex]);
      windows[turnIndex] = { start, end, inferredFromAuthoredSegment: true, segmentIndex };
      cursor = end + (groupIndex < turnIndices.length - 1 ? 0.15 : 0);
    });
  }
  return windows.every(Boolean) ? { used: true, windows } : { used: false, windows: [] };
}

function exactTurnWindow(turn, index, timing, duration) {
  const authoredStart = Number(turn?.start ?? turn?.startSecond);
  const authoredEnd = Number(turn?.end ?? turn?.endSecond);
  if (timing?.authoredTimingAdequate && Number.isFinite(authoredStart) && Number.isFinite(authoredEnd) && authoredEnd > authoredStart) {
    return timing.slots[index] || { start: Math.max(0.30, authoredStart), end: Math.min(duration - 0.35, authoredEnd) };
  }
  return timing.slots[index] || { start: 0, end: timing.speechSpan };
}

function dialogueSpeakerCutTimes(turns = [], windows = []) {
  const cuts = [];
  for (let index = 1; index < turns.length; index += 1) {
    const previous = clean(turns[index - 1]?.speakerId || turns[index - 1]?.speaker);
    const current = clean(turns[index]?.speakerId || turns[index]?.speaker);
    const at = Number(windows[index]?.start);
    if (turns[index]?.onScreen !== false && previous && current && previous !== current && Number.isFinite(at) && at > 0) cuts.push(at);
  }
  return cuts;
}

function alignVisualSegmentsToSpeakerCuts(segments = [], cutTimes = [], duration = 10) {
  const aligned = list(segments).map(segment => ({ ...segment }));
  // Do not manufacture a second physical action from one legacy take. The
  // selected final editor authors any additional camera coverage explicitly.
  if (aligned.length < 2 || !cutTimes.length) return aligned;
  const used = new Set();
  for (const [cutIndex, cutTime] of unique(cutTimes.map(Number).filter(Number.isFinite)).sort((a, b) => a - b).entries()) {
    const existingBoundary = aligned.slice(0, -1).some((segment, index) => (
      Math.abs(Number(segment.end) - cutTime) <= 0.05
      && Math.abs(Number(aligned[index + 1].start) - cutTime) <= 0.05
    ));
    if (existingBoundary) continue;

    // Speaker and silence boundaries frequently land inside an authored
    // visual beat. Moving the beat's original end erased the following
    // reaction/action (for example, a witness reveal after a kiss). Split the
    // containing beat instead: the dialogue reconciler may specialize the
    // speaking half while the authored physical consequence remains intact.
    const containingIndex = aligned.findIndex(segment => (
      cutTime > Number(segment.start) + 0.05
      && cutTime < Number(segment.end) - 0.05
    ));
    if (containingIndex >= 0) {
      const containing = aligned[containingIndex];
      aligned.splice(containingIndex, 1,
        { ...containing, end: cutTime },
        { ...containing, start: cutTime });
      continue;
    }

    const candidates = aligned.slice(0, -1).map((segment, index) => ({
      index,
      distance: Math.abs(((Number(segment.end) + Number(aligned[index + 1].start)) / 2) - cutTime)
    })).filter(item => !used.has(item.index)).sort((left, right) => {
      const leftPreferred = left.index === cutIndex ? -1 : 0;
      const rightPreferred = right.index === cutIndex ? -1 : 0;
      return leftPreferred - rightPreferred || left.distance - right.distance;
    });
    // A camera boundary and a speaker/mouth boundary may never disagree.  Pick
    // the nearest boundary that can legally move to the exact dialogue cut,
    // even when an upstream equal-slot storyboard placed it farther away.
    const nearest = candidates.find(candidate => {
      const left = aligned[candidate.index];
      const right = aligned[candidate.index + 1];
      return cutTime > Number(left.start) + 0.05 && cutTime < Number(right.end) - 0.05;
    });
    if (!nearest) continue;
    const left = aligned[nearest.index];
    const right = aligned[nearest.index + 1];
    left.end = cutTime;
    right.start = cutTime;
    used.add(nearest.index);
  }
  return aligned;
}

function reconcileReflowedDialogueVisuals(segments = [], cues = [], timing = {}, duration = 10) {
  if (timing?.authoredTimingAdequate || !cues.length) return list(segments);
  const spanningCueIndices = new Set(cues.filter(cue => list(segments).filter(segment => {
    const overlap = Math.max(0,
      Math.min(Number(segment?.end) || duration, Number(cue?.window?.end) || 0)
      - Math.max(Number(segment?.start) || 0, Number(cue?.window?.start) || 0));
    return overlap > 0.05;
  }).length > 1).map(cue => Number(cue?.index)));
  const reconciled = list(segments).map(segment => {
    const start = Number(segment?.start) || 0;
    const end = Number(segment?.end) || duration;
    const overlapping = cues.map(cue => ({
      cue,
      overlap: Math.max(0, Math.min(end, Number(cue?.window?.end) || 0) - Math.max(start, Number(cue?.window?.start) || 0))
    })).filter(item => item.overlap > 0.05).sort((left, right) => right.overlap - left.overlap);
    if (!overlapping.length) return segment;

    const cue = overlapping[0].cue;
    const sourceIndex = Number(cue?.sourceSegmentIndex);
    const segmentIndex = Number(segment?.timelineSourceIndex);
    const mismatchedSource = cue?.authoredWindow === true
      && Number.isInteger(sourceIndex)
      && sourceIndex >= 0
      && Number.isInteger(segmentIndex)
      && segmentIndex !== sourceIndex;
    const contradictorySpeechLabel = cue?.authoredWindow === true
      && /\b(?:silent|no one speaks|without dialogue|speak in sequence|both\s+\w+\s+and\s+\w+\s+speak)\b/i.test(String(segment?.action || ""));
    const speechVerb = "(?:speak|say|ask|answer|reply|respond|apologi[sz]e|admit|declare|shout|yell|whisper)[a-z]*";
    const contradictoryDialogueOwner = cue?.authoredWindow === true
      && cues.some(otherCue => {
        const otherId = clean(otherCue?.speakerId);
        if (!otherId || otherId === clean(cue?.speakerId)) return false;
        return new RegExp(`(?:${regexEscape(otherId)}[\\s\\S]{0,140}\\b${speechVerb}\\b|\\b${speechVerb}\\b[\\s\\S]{0,140}${regexEscape(otherId)})`, "i")
          .test(String(segment?.action || ""));
      });
    const spansLegacyBoundary = cue?.authoredWindow === true
      && cue?.visibleSpeech !== false
      && spanningCueIndices.has(Number(cue?.index));
    if (!mismatchedSource && !contradictorySpeechLabel && !contradictoryDialogueOwner && !spansLegacyBoundary) return segment;
    const source = cue?.sourceSegment || segment;
    const isTimelineStart = start <= 0.05;
    const isTimelineEnd = end >= duration - 0.05;
    const before = cue?.index === 0
      ? (isTimelineStart ? segment?.before : source?.before) || "the authored elapsed-time transition is already complete and the speaking beat is ready"
      : "the previous speaker has closed the mouth and the exact prior reaction state continues";
    const after = cue?.index === cues.length - 1
      ? (isTimelineEnd ? segment?.after : source?.after) || "the final speaker closes the mouth and the authored reaction is complete"
      : "the active speaker finishes the full line, closes the mouth, and the listener reaction reaches the next cut point";
    return {
      ...segment,
      dialogueCueIndex: Number(cue?.index),
      // When an authored dialogue window is too short, dialogueTimingPlan
      // reflows the complete line rather than truncating it. The previous
      // compiler moved the cut but retained an old "silent" montage action,
      // giving H3 two contradictory clocks. In a reflowed speaking window,
      // the speaker's authored performance becomes the one visual authority;
      // any elapsed-time montage is represented by the opening state instead.
      action: [cue?.body, `${cue?.speaker} remains the sole active speaking face for the overlapping part of the once-only timed dialogue below; a visual cut never restarts or repeats that utterance`]
        .map(clean).filter(Boolean).join("; "),
      camera: `hold a centered readable medium close-up on ${cue?.speaker}; keep the speaking mouth unobstructed and cut only at the next authored speaker change`,
      before,
      after,
      blocking: unique([source?.blocking, cue?.blocking, cue?.facing].map(clean).filter(Boolean)).join("; "),
      backgroundAction: cue?.listenerReaction || segment?.backgroundAction,
      sound: source?.sound || segment?.sound
    };
  });

  // A reflowed line can overlap two legacy visual segments after the old
  // storyboard's equal-slot timing is replaced by natural speech timing.  If
  // both segments are now owned by the same speaker, keeping the legacy cut
  // would describe the same line twice and tempt H3 to restart it.  Collapse
  // that artificial boundary into one uninterrupted speaking take.  Genuine
  // speaker changes and unrelated visual beats remain separate segments.
  return reconciled.reduce((merged, segment) => {
    const previous = merged[merged.length - 1];
    const sameDialogueCue = previous
      && Number.isInteger(previous.dialogueCueIndex)
      && previous.dialogueCueIndex === segment.dialogueCueIndex
      && Math.abs(Number(previous.end) - Number(segment.start)) <= 0.06;
    if (!sameDialogueCue) {
      merged.push(segment);
      return merged;
    }
    previous.end = segment.end;
    previous.after = segment.after || previous.after;
    previous.sound = unique([previous.sound, segment.sound]).filter(Boolean).join("; ");
    previous.camera = previous.camera
      ? `${String(previous.camera).replace(/[.!?]+$/g, "")}; maintain this uninterrupted speaking take through the removed legacy cut`
      : segment.camera;
    previous.backgroundAction = previous.backgroundAction || segment.backgroundAction;
    return merged;
  }, []);
}

function dialogueAlignedVisualWindows(shot = {}, turns = [], durationSeconds = 10) {
  const duration = Math.max(1, Number(durationSeconds) || Number(shot?.duration) || 10);
  const timing = dialogueTimingPlan(turns, duration);
  const dialogueWindows = list(turns).map((turn, index) => exactTurnWindow(turn, index, timing, duration));
  let segments = timedVisualSegments({}, shot, turns, duration);
  const visualBoundaryTimes = dialogueWindows.slice(1).map(window => Number(window.start)).filter(Number.isFinite);
  if (segments.length > turns.length && timing.speechSpan > 0.05 && timing.speechSpan < duration - 0.05) {
    visualBoundaryTimes.push(timing.speechSpan);
  }
  if (!timing.authoredTimingAdequate) segments = alignVisualSegmentsToSpeakerCuts(segments, visualBoundaryTimes, duration);
  return segments.map(segment => ({ start: Number(segment.start) || 0, end: Number(segment.end) || duration }));
}

function sanitizeVisualPromptCue(value = "") {
  return clean(value)
    // A model may copy a screenplay speaking line into a subshot's visual
    // action field.  The immutable dialogue ledger already owns that line;
    // remove the dialogue-shaped clause here so action prose can never be
    // spoken, repeated or shown as a director instruction in the final prompt.
    .replace(/(?:^|[。；])\s*[^。；\n]{0,40}[（(][^）)\n]{0,80}(?:说|对白|语气)[^）)\n]{0,80}[）)]\s*[:：][^。；\n]*(?:[。；]|$)/g, " ")
    // Spoken dialogue may state the elapsed time, but a visual direction must
    // not ask H3 to render phone/display digits.  Preserve the dramatic beat as
    // an observable wait-complete action without priming a graphic surface.
    .replace(/(?:(?:手机|电子屏|显示屏|屏幕)\s*(?:计时器?|倒计时)?|计时器|倒计时)\s*(?:停在|显示|跳到|归零|到达)?\s*(?:\d+(?:\.\d+)?|[一二三四五六七八九十百两]+)\s*(?:分钟|秒钟?|分)\s*(?:到了?|结束)?/g, "等待结束")
    .replace(/(?:看一眼|盯着|查看)\s*(?:手机|电子屏|显示屏|屏幕)?\s*(?:计时器?|倒计时)/g, "听到提醒声")
    // The production contract has no music track.  Convert a visual beat that
    // merely uses music as an event marker into the same event transition.
    .replace(/(?:婚礼|宴会|现场)?\s*(?:背景)?音乐(?:缓缓|突然)?响起/g, "现场仪式正式开始")
    .replace(/\bBGM\b|background\s+music|underscore|soundtrack/gi, "")
    .replace(/等待等待结束/g, "等待结束")
    .replace(/\s{2,}/g, " ")
    .replace(/[，、；]{2,}/g, "，")
    .trim();
}

function officialReferenceTaskTypes(references={}){
  const imageRoles=list(references.imageRoles),videoRoles=list(references.videoRoles);
  const concrete=new Set(['storyboard_start','storyboard_end','storyboard_timeline_panel','first_frame','last_frame','keyframe']);
  const types=[];
  if(videoRoles.some(r=>clean(r?.type)==='previous_shot'))types.push('video continuation');
  if(imageRoles.some(r=>concrete.has(clean(r?.type))))types.push('keyframe completion');
  if(imageRoles.some(r=>!concrete.has(clean(r?.type)))||videoRoles.some(r=>clean(r?.type)!=='previous_shot')||(!imageRoles.length&&list(references.images).length))types.push('reference generation');
  if(list(references.audios).length)types.push('audio reference');
  return types.length?types.join(' + '):'reference generation';
}

function temporalContract(project = {}, shot = {}, references = {}) {
  const roles = list(references?.imageRoles);
  const startIndex = roles.findIndex(role => clean(role?.type) === "storyboard_start");
  const endIndex = roles.findIndex(role => clean(role?.type) === "storyboard_end");
  const sheetIndex = roles.findIndex(role => ["storyboard_sheet", "storyboard_generation_block_sheet", "storyboard_take_sheet"].includes(clean(role?.type)));
  const timelinePanels = roles.map((role, index) => ({ role, index }))
    .filter(item => clean(item.role?.type) === "storyboard_timeline_panel");
  const hasPreviousVideo = list(references?.videoRoles).some(role => clean(role?.type) === "previous_shot");
  const requested = clean(references?.promptMode || references?.videoStrategy || shot?.videoStrategy || project?.generation?.mode).toLowerCase();
  const mode = requested.includes("asset_direct")
    ? "asset_direct"
    : requested.includes("storyboard_sheet") || sheetIndex >= 0 || timelinePanels.length
    ? "storyboard_sheet"
    : requested.includes("continuation") || hasPreviousVideo || (startIndex < 0 && endIndex >= 0)
      ? "continuation"
      : "keyframe";
  if (mode === "asset_direct") {
    return "temporal_contract: Identity, scene and prop references constrain continuity only; they are not opening frames. Perform the authored before-state, complete causal actions and timed reactions, then the completed after-state once; never replay, reset or film a reference board.";
  }
  if (mode === "storyboard_sheet") {
    if (timelinePanels.length) {
      const schedule = timelinePanels.map(({ role, index }) => {
        const start = Number.isFinite(Number(role?.startSecond)) ? Number(role.startSecond) : Number(role?.panelIndex) || 0;
        const end = Number.isFinite(Number(role?.endSecond)) ? Number(role.endSecond) : start + 1;
        return `${timestamp(start, true)}-${timestamp(end, true)}s=<Picture ${index + 1}>`;
      }).join("; ");
      return `temporal_contract: ordered independent 9:16 storyboard frames; ${schedule}; follow every supplied frame in order, carrying identity and physical state forward between frames.`;
    }
    return sheetIndex >= 0
      ? `temporal_contract: Use <Picture ${sheetIndex + 1}> panels left-to-right, top-to-bottom as temporal guidance for this filmed scene; never reproduce the panel layout.`
      : "temporal_contract: Execute the authored continuous scene timeline; no storyboard image is supplied.";
  }
  if (mode === "continuation") {
    const previous = hasPreviousVideo ? "0.0s inherits only the previous video's final state; continue without replay." : "The supplied frame is the inherited opening state.";
    const end = endIndex >= 0 ? `Finish at <Picture ${endIndex + 1}> as the completed state; no reset.` : "Finish on the authored completed state.";
    return `temporal_contract: ${previous} ${end}`;
  }
  const atomicSpeakerBlock = references?.agentGenerationBlock
    && list(shot?.dialogueTurns).some(turn => turn?.onScreen !== false && clean(turn?.speakerId || turn?.speaker));
  const start = startIndex >= 0
    ? atomicSpeakerBlock
      ? `At 0.0 seconds, <Picture ${startIndex + 1}> locks the before-action set, props and blocking; the active speaker framing contract controls camera dominance.`
      : `At 0.0 seconds, <Picture ${startIndex + 1}> is the exact before-action state.`
    : "At 0.0 seconds, use the authored before-action state.";
  const end = endIndex >= 0 ? `At the final frame, <Picture ${endIndex + 1}> is the exact after-action state.` : "At the final frame, show the authored action visibly complete.";
  return `temporal_contract: ${start} ${end} Build one causal action chain; never swap, merge, replay, or reset either endpoint.`;
}

function crossShotHandoffDirective(project = {}, shot = {}, bindings = {}, references = {}) {
  const bindHandoffCue = value => bindProviderCueSubjects(value, bindings, references)
    // A legacy or user-authored state can still contain internal entity ids that
    // have no media reference in this shot. Never send those opaque ids to H3.
    .replace(/\bC\d+\b/gi, "the established character")
    .replace(/\bP\d+\b/gi, "the established prop")
    .replace(/\bSC\d+\b/gi, "the established set");
  const shotNumber = value => Number(value?.number) || Number(clean(value?.id).match(/\d+/)?.[0]) || 0;
  const currentNumber = shotNumber(shot);
  const previous = list(project?.shots)
    .filter(item => clean(item?.id) !== clean(shot?.id) && shotNumber(item) < currentNumber)
    .sort((left, right) => shotNumber(right) - shotNumber(left))[0] || null;
  const currentBefore = bindHandoffCue(deterministicEnglishCue(
    shot?.stateBeforeEn || shot?.startFrameEn,
    "state",
    "the authored opening blocking, wardrobe, prop ownership, eyelines, and emotional state",
    220
  ));
  if (!previous) {
    return `cross_shot_handoff: This is the first shot. Begin directly from ${currentBefore}; do not invent or replay a prior action.`;
  }
  const previousAfter = bindHandoffCue(deterministicEnglishCue(
    previous?.stateAfterEn || previous?.endFrameEn,
    "state",
    "the exact completed blocking, wardrobe, prop ownership, eyelines, and emotional residue from the previous shot",
    220
  ));
  const previousScene = clean(previous?.sceneId || previous?.sceneNameEn || previous?.sceneEn);
  const currentScene = clean(shot?.sceneId || shot?.sceneNameEn || shot?.sceneEn);
  const sameScene = Boolean(previousScene && currentScene && previousScene === currentScene);
  const reason = bindHandoffCue(deterministicEnglishCue(
    shot?.transitionReasonEn || shot?.causalLinkEn || shot?.cutReasonEn,
    "action",
    sameScene ? "continue the same causal beat" : "perform the authored motivated scene transition",
    180
  ));
  const spatialRule = sameScene
    ? "Keep screen-left/right and foreground/background positions, facing, eyeline axis, wardrobe, prop ownership, and emotional residue continuous; do not jump position, replay, or reset."
    : `Move from ${providerStableId(previousScene, "previous-set")} to ${providerStableId(currentScene, "current-set")} only through the authored causal transition; do not teleport, duplicate, replace, or reset a character.`;
  return `cross_shot_handoff: Inherit ${previousAfter} from ${providerStableId(previous?.id, "previous-shot")}, then enter ${currentBefore}. ${reason}. ${spatialRule}`;
}

function integratedTimelineTimestamp(value) {
  const milliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function chineseAuthoredCue(value, fallback = "") {
  if (value && typeof value === "object") {
    return chineseAuthoredCueBundle([
      value.deliveryZh, value.delivery, value.tone, value.emotion, value.vocalArcZh, value.vocalArc,
      value.expressionZh, value.expression, value.bodyZh, value.body, value.listenerReactionZh, value.listenerReaction
    ], fallback);
  }
  const source = clean(value);
  const containsChinese = /[\u3400-\u9fff]/.test(source);
  const containsEnglishWords = /[A-Za-z]{2,}/.test(source);
  if (containsChinese && !containsEnglishWords) return source;
  if (!source) return clean(fallback);
  const translated = [];
  const add = (pattern, text) => { if (pattern.test(source)) translated.push(text); };
  add(/angry accusation|furious accusation/i, "愤怒质问");
  add(/tearful confession/i, "含泪坦白");
  add(/hard stress|heavy stress|keyword stress/i, "关键词重音明确");
  add(/restrained sob|tearful|trembl/i, "压住哭腔，气息和句尾带颤");
  add(/sharp protective command|protective command/i, "随后收紧成凌厉的保护性命令");
  add(/restrained anger|clipped stress/i, "压住怒意，重音短促");
  add(/high volume|sharp attack/i, "音量抬高，起音凌厉");
  add(/soft|reassur/i, "声音放轻，带明确安抚感");
  add(/fast pace|clipped breath/i, "语速加快，气息短促");
  add(/lower volume|slower ending/i, "后半句压低音量并放慢句尾");
  add(/medium[- ]?low volume/i, "以中低音量起句");
  add(/(?:rise|raise|lift)[^.;,]{0,36}(?:volume|pitch)|(?:volume|pitch)[^.;,]{0,36}(?:rise|raise|lift)/i, "压力词处抬高音量和声调");
  add(/volume/i, "音量随情绪强弱形成清楚变化");
  add(/pitch|contour/i, "声调有明确起伏");
  add(/pace|tempo/i, "语速随语义推进变化");
  add(/pause|beat/i, "停顿落在语义转折处");
  add(/lunge|weight shift|body|takes? (?:one )?(?:small )?step|steps? (?:between|toward|forward|back)/i, "身体重心随语义发生清楚变化");
  add(/hand|grip|arm/i, "手部动作只在重音处发生一次必要变化");
  add(/eyes|gaze|brow|jaw|micro-expression/i, "眼神、眉峰、下颌和微表情随情绪推进");
  add(/closed lips|still lips|resting lips/i, "保持闭口");
  add(/breath/i, "呼吸节奏可见变化");
  add(/hard cut/i, "按说话人变化直接硬切");
  add(/push-in/i, "克制推近");
  add(/medium close-up/i, "中近景");
  add(/scissors?[^.;,]{0,30}(?:snip|cut)|(?:snip|cut)[^.;,]{0,30}scissors?/i, "金属剪刀清脆剪断声");
  add(/paper[^.;,]{0,30}(?:slam|impact|thud)|(?:document|envelope|folder)[^.;,]{0,30}(?:slam|impact|thud)/i, "纸张或文件袋落在桌面的同步闷响");
  add(/doorbell|bell rings?/i, "清楚的门铃声");
  add(/applause|clapp/i, "现场掌声");
  add(/footsteps?|shoe steps?/i, "与步伐同步的脚步声");
  add(/fabric|cloth|sleeve|rustl/i, "衣料随动作产生的轻微摩擦声");
  add(/room tone|ambience|ambient/i, "连续现场环境底噪");
  const stressedChinese = source.match(/(?:stress(?:ed)?\s+on|emphasis\s+on)\s*([\u3400-\u9fff\d]+)/i)?.[1];
  if (stressedChinese) translated.push(`重音落在“${stressedChinese}”`);
  if (!translated.length && containsChinese) {
    const chineseFragments = source.match(/[\u3400-\u9fff][\u3400-\u9fff\d]*/g) || [];
    if (chineseFragments.length) translated.push(chineseFragments.join("，"));
  }
  return unique(translated).join("，") || clean(fallback);
}

function chineseAuthoredCueBundle(values = [], fallback = "") {
  const cues = unique(list(values)
    .map(value => chineseAuthoredCue(value, ""))
    .filter(Boolean)
    .flatMap(value => String(value).split(/[，；;。]+/u))
    .map(value => trimChineseClause(value))
    .filter(Boolean));
  return cues.join("，") || clean(fallback);
}

function trimChineseClause(value) {
  return clean(value).replace(/[\s。！？；，!?;,]+$/g, "");
}

function chineseVisualActionCue(value, fallback = "") {
  const source = clean(value);
  if (!source) return trimChineseClause(fallback);
  if (/[\u3400-\u9fff]/.test(source)) return trimChineseClause(chineseAuthoredCue(source, fallback));
  // English-only legacy action mirrors cannot be translated faithfully with a
  // keyword table. Use the already authored Chinese shot/segment fallback
  // instead of turning words such as "hand" into an invented performance cue.
  return trimChineseClause(fallback);
}

function chinesePhysicalStateCue(value, fallback = "") {
  const source = clean(value);
  if (!source) return "";
  if (/[\u3400-\u9fff]/.test(source)) return trimChineseClause(chineseAuthoredCue(source, fallback));
  return trimChineseClause(fallback);
}

function chineseSoundCue(value, fallback = "") {
  const source = clean(value);
  if (!source) return "";
  if (/[\u3400-\u9fff]/.test(source)) return trimChineseClause(source);
  const translated = [];
  const add = (pattern, text) => { if (pattern.test(source)) translated.push(text); };
  add(/room tone|ambience|ambient|location bed|background hum/i, "连续现场环境底噪");
  add(/breath|breathing/i, "与表演同步的呼吸声");
  add(/footsteps?|shoe steps?/i, "与步伐同步的脚步声");
  add(/fabric|cloth|sleeve|rustl/i, "衣料随动作产生的轻微摩擦声");
  add(/bed[- ]?frame|bed movement/i, "床架随动作产生的真实响动");
  add(/body impact|body thud|impact|thud/i, "与画面动作同步的真实撞击声");
  add(/surface friction|scrape/i, "与接触动作同步的表面摩擦声");
  add(/paper|document|envelope|folder/i, "与纸张或文件动作同步的声音");
  add(/scissors?|snip/i, "金属剪刀清脆剪断声");
  add(/metal clicks?|latch clicks?/i, "与机关动作同步的金属卡扣声");
  add(/doorbell|bell rings?/i, "清楚的门铃声");
  add(/applause|clapp/i, "与群像动作同步的现场掌声");
  add(/door movement|door opens?|door closes?/i, "与开关门动作同步的门体声音");
  add(/phone vibration/i, "一次短促的手机震动声");
  add(/water|rinse/i, "与画面同步的水流声");
  add(/towel/i, "毛巾接触头发的轻柔摩擦声");
  add(/hair[- ]?dryer|blow[- ]?dry/i, "与画面同步的吹风机声");
  return trimChineseClause(unique(translated).join("，") || fallback || "与画面可见动作同步的现场声音");
}

function integratedCharacter(project = {}, token = "") {
  const key = clean(token);
  const character = list(project?.characters).find(item => clean(item?.id) === key || clean(item?.name) === key) || null;
  const id = clean(character?.id || key);
  const name = clean(character?.name || key || "未指定人物");
  return {
    id,
    name,
    label: id && id !== name ? `${id} ${name}` : name
  };
}

function integratedSceneLabel(project = {}, shot = {}) {
  const sceneToken = clean(shot?.sceneId || shot?.sceneName || shot?.scene);
  const scene = list(project?.scenes).find(item => clean(item?.id) === sceneToken || clean(item?.name) === sceneToken) || null;
  return chineseAuthoredCue(scene?.name || shot?.sceneName || shot?.scene, "当前剧情场景");
}

function integratedReferenceBinding(project = {}, references = {}, bindings = {}) {
  const roles = list(references?.imageRoles);
  const images = list(references?.images);
  const imageCount = Math.max(roles.length, images.length);
  const dedicatedAppearanceOwnerIds = new Set(roles
    .filter(role => clean(role?.type) === "wardrobe")
    .map(role => clean(role?.characterId || role?.ownerId))
    .filter(Boolean));
  const entries = [];
  for (let index = 0; index < imageCount; index += 1) {
    const role = roles[index] || {};
    const type = clean(role?.type);
    const entityId = clean(role?.entityId || role?.characterId || role?.sceneId || role?.productId || role?.propId || role?.wardrobeId);
    const picture = `<Picture ${index + 1}>`;
    if (type === "character") {
      const character = integratedCharacter(project, entityId);
      const subject = bindings?.subjects?.get(entityId) || bindings?.ensureSubject?.(entityId) || "";
      entries.push(dedicatedAppearanceOwnerIds.has(entityId)
        ? `人物 ${character.label}${subject ? `（${subject}）` : ""}的脸、年龄、体型和不可变身份仅参考${picture}，发型与服装服从该人物的当前专用外观参考`
        : `人物 ${character.label}${subject ? `（${subject}）` : ""}的脸、年龄、发型和当前服装仅参考${picture}`);
    } else if (type === "scene") {
      const scene = list(project?.scenes).find(item => clean(item?.id) === entityId || clean(item?.name) === entityId);
      const subject = bindings?.subjects?.get(`scene:${entityId}`) || "";
      entries.push(`场景“${chineseAuthoredCue(scene?.name || entityId, "当前场景")}”${subject ? `（${subject}）` : ""}的空间布局、门窗家具、光线和轴线仅参考${picture}这张完整四视图原图，保持原比例，不裁切、不拆分`);
    } else if (type === "product") {
      const subject = bindings?.subjects?.get(`product:${entityId}`) || "";
      entries.push(`商品“${clean(project?.product?.name) || "当前商品"}”${subject ? `（${subject}）` : ""}的真实外观、材质和比例仅参考${picture}`);
    } else if (type === "prop") {
      const subject = bindings?.subjects?.get(`prop:${entityId}`) || "";
      entries.push(`剧情物品 ${entityId || "当前道具"}${subject ? `（${subject}）` : ""}的外观、比例和持有关系仅参考${picture}`);
    } else if (type === "wardrobe") {
      const ownerId = clean(role?.characterId || role?.ownerId || entityId);
      const subject = bindings?.subjects?.get(ownerId) || bindings?.ensureSubject?.(ownerId) || "";
      entries.push(`人物 ${integratedCharacter(project, ownerId).label}${subject ? `（${subject}）` : ""}的当前完整服装仅参考${picture}`);
    } else if (type === "storyboard_start") {
      entries.push(`${picture}是00:00.000的精确剧情首帧`);
    } else if (type === "storyboard_end") {
      entries.push(`${picture}是本镜动作完成后的精确剧情尾帧`);
    } else if (type === "storyboard_timeline_panel") {
      const start = integratedTimelineTimestamp(role?.startSecond);
      const end = integratedTimelineTimestamp(Number.isFinite(Number(role?.endSecond)) ? role.endSecond : Number(role?.startSecond) + 1);
      entries.push(`${picture}是${start}—${end}的逐秒剧情构图与动作状态参考`);
    } else if (["storyboard_generation_block_sheet", "storyboard_take_sheet", "storyboard_sheet", "storyboard_panel_anchor"].includes(type)) {
      entries.push(`${picture}是按从左到右、从上到下执行的有序剧情分镜合图`);
    } else {
      entries.push(`${picture}是本镜相关视觉参考`);
    }
  }
  list(references?.videos).forEach((_item, index) => {
    const role = list(references?.videoRoles)[index] || {};
    entries.push(role?.type === "previous_shot"
      ? `<Video ${index + 1}>只提供上一镜最后一刻的动作、空间和声场承接状态`
      : `<Video ${index + 1}>只提供本镜需要的运动和机位节奏参考`);
  });
  list(references?.audios).forEach((audio, index) => {
    const character = integratedCharacter(project, audio?.characterId || audio?.characterName);
    const subject = bindings?.subjects?.get(character.id) || bindings?.ensureSubject?.(character.id) || "";
    entries.push(`<Audio ${index + 1}>只提供人物 ${character.label}${subject ? `（${subject}）` : ""}的声线身份，不复读参考音频内容`);
  });
  return entries.length
    ? `参考绑定：${entries.join("；")}。`
    : "参考绑定：沿用本项目已确认的人物、场景、服装和道具状态，不新增核心人物或空间。";
}

function integratedSegmentSource(shot = {}, segment = {}, eventIndex = 0) {
  const subshots = list(shot?.subshots);
  const sourceIndex = Number.isFinite(Number(segment?.timelineSourceIndex))
    ? Number(segment.timelineSourceIndex)
    : Math.min(eventIndex, Math.max(0, subshots.length - 1));
  return subshots[sourceIndex] || subshots[eventIndex] || {};
}

function integratedMultimodalDescription({
  project = {},
  shot = {},
  references = {},
  bindings = {},
  turns = [],
  duration = 10,
  visualSegments = [],
  resolvedDialogueWindows = [],
  screenSideByCharacterId = new Map(),
  mode = "keyframe"
}) {
  const scene = integratedSceneLabel(project, shot);
  const aspect = clean(project?.generation?.aspectRatio || "9:16");
  const dialogueCharacterIds = unique(turns.flatMap(turn => [turn?.speakerId || turn?.speaker, ...list(turn?.listenerIds)]));
  const referencedCharacterIds = unique([
    ...list(references?.imageRoles)
      .filter(role => clean(role?.type) === "character")
      .map(role => clean(role?.entityId || role?.characterId)),
    ...list(references?.audios).map(audio => clean(audio?.characterId || audio?.characterName))
  ]).filter(Boolean);
  let characterIds = unique([
    ...list(shot?.characterIds),
    ...list(shot?.visibleCharacterIds),
    ...dialogueCharacterIds
  ]).filter(Boolean);
  // When the paid request carries an explicit character-reference manifest,
  // an unreferenced silent supporting ID must not leak into the provider cast.
  // Dialogue owners stay authoritative even when a user intentionally runs
  // text-only speech without a portrait; every other unuploaded ID is omitted.
  if (referencedCharacterIds.length) {
    const allowed = new Set([...referencedCharacterIds, ...dialogueCharacterIds].map(clean));
    characterIds = characterIds.filter(id => allowed.has(clean(id)));
  }
  const segmentForWindow = (start, end, index) => {
    const candidate = visualSegments
      .map(segment => ({
        segment,
        overlap: Math.max(0, Math.min(Number(segment?.end) || duration, end) - Math.max(Number(segment?.start) || 0, start))
      }))
      .sort((left, right) => right.overlap - left.overlap)[0];
    return candidate?.overlap > 0 ? candidate.segment : visualSegments[Math.min(index, Math.max(0, visualSegments.length - 1))] || {};
  };
  const events = [];
  if (turns.length) {
    let cursor = 0;
    turns.forEach((turn, index) => {
      const window = resolvedDialogueWindows[index] || { start: cursor, end: duration };
      const start = Math.max(cursor, Math.max(0, Number(window.start) || 0));
      const end = Math.max(start + 0.05, Math.min(duration, Number(window.end) || duration));
      if (start > cursor + 0.12) events.push({ type: "silent", start: cursor, end: start, segment: segmentForWindow(cursor, start, events.length) });
      events.push({ type: "dialogue", start, end, turn, turnIndex: index, segment: segmentForWindow(start, end, events.length) });
      cursor = Math.max(cursor, end);
    });
    if (cursor < duration - 0.12) events.push({ type: "silent", start: cursor, end: duration, segment: segmentForWindow(cursor, duration, events.length) });
  } else if (visualSegments.length) {
    visualSegments.forEach(segment => events.push({
      type: "silent",
      start: Math.max(0, Number(segment?.start) || 0),
      end: Math.max(Number(segment?.start) || 0, Math.min(duration, Number(segment?.end) || duration)),
      segment
    }));
  } else {
    events.push({ type: "silent", start: 0, end: duration, segment: {} });
  }

  // A dialogue window may split one authored visual segment into a silent
  // lead-in, speaking take and silent tail.  Emit that segment's exact causal
  // action only in the event with the greatest temporal overlap; repeating the
  // same action in all three windows made H3 replay it and made the review
  // prompt look formulaic.  Other windows inherit the reached physical state.
  const primaryEventBySegment = new Map();
  events.forEach((event, index) => {
    const segment = event?.segment;
    if (!segment || typeof segment !== "object") return;
    const start = Math.max(Number(event.start) || 0, Number(segment.start) || 0);
    const end = Math.min(Number(event.end) || duration, Number(segment.end) || duration);
    const overlap = Math.max(0, end - start);
    const previous = primaryEventBySegment.get(segment);
    if (!previous || overlap > previous.overlap) primaryEventBySegment.set(segment, { index, overlap });
  });

  const lines = [HAILUO_INTEGRATED_PROMPT_HEADER, integratedReferenceBinding(project, references, bindings)];
  const emittedActionCues = new Set();
  const emittedSoundCues = new Set();
  events.forEach((event, index) => {
    const source = integratedSegmentSource(shot, event.segment, index);
    const compiledSegment = event.segment || {};
    const isPrimarySegmentEvent = (primaryEventBySegment.get(compiledSegment)?.index ?? index) === index;
    const framing = trimChineseClause(chineseAuthoredCue(compiledSegment?.framingZh || source?.framingZh || source?.framing || source?.framingEn || source?.shotSize || shot?.shotSize || shot?.shotSizeEn, event.type === "dialogue" ? "中近景" : "中景"));
    const authoredCamera = trimChineseClause(chineseAuthoredCue(compiledSegment?.cameraZh || source?.cameraZh || source?.camera || source?.cameraEn || source?.cameraMove || shot?.cameraMove || shot?.cameraMoveEn, index ? "按动作结果或说话人变化直接硬切" : "机位稳定"));
    let authoredAction = chineseVisualActionCue(
      isPrimarySegmentEvent
        ? (compiledSegment?.actionZh || source?.actionZh || source?.action || source?.visualBeat
          || (index === 0 ? (shot?.action || shot?.visualBeat) : "")
          || compiledSegment?.action || source?.actionEn || source?.visualBeatEn || (index === 0 ? (shot?.actionEn || shot?.visualBeatEn) : ""))
        : "",
      index === 0 ? "从原稿开场状态推进本镜唯一因果动作" : "承接上一时段状态，完成当前剧情动作与可见反应"
    );
    if (authoredAction && emittedActionCues.has(authoredAction)) {
      authoredAction = "承接上一时段已经完成的动作结果，继续当前表演，不重演此前动作";
    } else if (authoredAction) {
      emittedActionCues.add(authoredAction);
    }
    const stateBeforeSource = index === 0
      ? (shot?.stateBefore || shot?.stateBeforeEn || shot?.startFrame || compiledSegment?.stateBeforeZh || source?.stateBeforeZh || source?.stateBefore || source?.stateBeforeEn)
      : isPrimarySegmentEvent
        ? (compiledSegment?.stateBeforeZh || source?.stateBeforeZh || source?.stateBefore || source?.stateBeforeEn)
        : "";
    const stateAfterSource = index === events.length - 1
      ? (shot?.stateAfter || shot?.stateAfterEn || shot?.endFrame || compiledSegment?.stateAfterZh || source?.stateAfterZh || source?.stateAfter || source?.stateAfterEn)
      : isPrimarySegmentEvent
        ? (compiledSegment?.stateAfterZh || source?.stateAfterZh || source?.stateAfter || source?.stateAfterEn)
        : "";
    const stateBefore = chinesePhysicalStateCue(stateBeforeSource, index === 0 ? "按原稿保持本镜动作发生前的人物站位、道具和空间状态" : "承接上一时段已经到达的物理状态");
    const stateAfter = chinesePhysicalStateCue(stateAfterSource, index === events.length - 1 ? "完成本镜原稿规定的清楚可见结果" : "完成当前时段规定的可见变化");
    const authoredBlocking = trimChineseClause(chineseAuthoredCue(compiledSegment?.blockingZh || source?.blockingZh || source?.blocking || source?.position || source?.eyelineDirection, ""));
    const authoredBackground = trimChineseClause(chineseAuthoredCue(compiledSegment?.backgroundActionZh || source?.backgroundActionZh || source?.backgroundAction || source?.ensembleAction || source?.listenerReaction, ""));
    let authoredSound = chineseSoundCue(
      compiledSegment?.soundZh || source?.soundZh || source?.sound || compiledSegment?.sound || compiledSegment?.soundEn || source?.soundEn
        || source?.audioPlan || source?.soundDesign || (isPrimarySegmentEvent ? (shot?.audioPlan || shot?.soundDesign) : ""),
      "与画面可见动作同步的现场声音"
    );
    if (authoredSound && emittedSoundCues.has(authoredSound)) authoredSound = "";
    else if (authoredSound) emittedSoundCues.add(authoredSound);
    const segmentDetails = [
      authoredBlocking ? `站位、朝向与视线：${authoredBlocking}` : "",
      authoredBackground ? `背景与听者动作：${authoredBackground}` : "",
      authoredSound ? `现场声音：${authoredSound}` : ""
    ].filter(Boolean).join("；");
    const header = index === 0
      ? `[镜头 1] 电影级真人实拍，竖屏 ${aspect} 画幅，场景为${scene}，机位与切镜服从剧情动作和说话人变化，全程保持180度视线轴线、人物屏幕方向和空间关系连续。`
      : `[镜头 ${index + 1}]`;
    lines.push(header);
    const time = `${integratedTimelineTimestamp(event.start)}—${integratedTimelineTimestamp(event.end)}`;
    if (event.type === "dialogue") {
      const turn = event.turn || {};
      const metadata = turn?.metadata || {};
      const speakerId = clean(turn?.speakerId || turn?.speaker);
      const speaker = integratedCharacter(project, speakerId);
      const speakerSubject = bindings?.subjects?.get(speakerId) || bindings?.ensureSubject?.(speakerId) || "";
      const listenerIds = unique(list(turn?.listenerIds).map(clean).filter(Boolean));
      const effectiveListenerIds = turn?.primaryListenerId ? [turn.primaryListenerId] : listenerIds;
      const listeners = effectiveListenerIds.map(id => integratedCharacter(project, id));
      const listenerText = listeners.length ? listeners.map(item => item.label).join("、") : "既定听者";
      const providerSide = screenSideByCharacterId.get(speakerId) || "the established screen side";
      const speakerSide = /left/i.test(providerSide) ? "画面左侧" : /right/i.test(providerSide) ? "画面右侧" : chineseAuthoredCue(providerSide, "既定画面侧");
      const tone = chineseAuthoredCueBundle([
        turn?.deliveryZh, metadata?.deliveryZh, turn?.sourceTone, metadata?.sourceTone, turn?.delivery, metadata?.delivery,
        turn?.deliveryEn, metadata?.deliveryEn, turn?.vocalArcZh, metadata?.vocalArcZh, turn?.vocalArcEn, metadata?.vocalArcEn,
        metadata?.tone, metadata?.emotion
      ],
        /[？?]/.test(clean(turn?.text || turn?.spokenText)) ? "带着明确试探与追问，句尾上扬但不松懈" : "符合当前冲突强度，重音、停顿和气息有清楚起伏"
      );
      const expression = chineseAuthoredCueBundle([
        turn?.expressionZh, metadata?.expressionZh, turn?.expressionArcZh, metadata?.expressionArcZh,
        turn?.expressionEn, metadata?.expressionEn, turn?.expressionArcEn, metadata?.expressionArcEn,
        turn?.facialArcEn, metadata?.facialArcEn, turn?.emotionPeak, metadata?.emotionPeak
      ],
        "眼神、眉峰、下颌和呼吸从起句情绪推进到压力词，并在句尾留下可见余波"
      );
      const body = chineseAuthoredCueBundle([
        turn?.bodyZh, metadata?.bodyZh, turn?.body, metadata?.body, turn?.bodyEn, metadata?.bodyEn,
        turn?.bodyActionEn, metadata?.bodyActionEn
      ],
        "身体重心与手部动作只随语义和重音产生一次必要变化"
      );
      const reaction = chineseAuthoredCueBundle([
        turn?.listenerReactionZh, metadata?.listenerReactionZh, turn?.listenerReaction, metadata?.listenerReaction,
        turn?.listenerBeat, metadata?.listenerBeat, turn?.listenerReactionEn, metadata?.listenerReactionEn,
        turn?.listenerBeatEn, metadata?.listenerBeatEn
      ],
        "保持闭口，通过眼神、呼吸、下颌或身体重心对这句话作同步细微反应"
      );
      const authoredFacingSource = clean([
        turn?.speakerFacingZh, metadata?.speakerFacingZh, turn?.facingZh, metadata?.facingZh,
        turn?.speakerFacing, metadata?.speakerFacing, turn?.facing, metadata?.facing,
        turn?.speakerFacingEn, metadata?.speakerFacingEn, turn?.facingEn, metadata?.facingEn
      ].find(Boolean));
      const authoredFacing = /[\u3400-\u9fff]/.test(authoredFacingSource)
        ? trimChineseClause(authoredFacingSource)
        : "";
      const directToViewer = turn?.directToViewer === true
        || metadata?.directToViewer === true
        || /^(?:viewer|camera|audience|观众|镜头)$/i.test(clean(turn?.addressMode || metadata?.addressMode));
      const audio = bindings?.audioByCharacterId?.get(speakerId) || "";
      const previousDialogueEvent = events.slice(0, index).reverse().find(item => item.type === "dialogue") || null;
      const previousSpeakerId = clean(previousDialogueEvent?.turn?.speakerId || previousDialogueEvent?.turn?.speaker);
      const cameraLead = index === 0
        ? `以${framing}拍摄人物 ${speaker.label}${speakerSubject ? `（${speakerSubject}）` : ""}`
        : previousSpeakerId && previousSpeakerId === speakerId
          ? `保持人物 ${speaker.label}${speakerSubject ? `（${speakerSubject}）` : ""}的${framing}和连续表演，不切换人物`
          : `镜头硬切至${speakerSide}人物 ${speaker.label}${speakerSubject ? `（${speakerSubject}）` : ""}的${framing}`;
      const faceDirection = directToViewer
        ? `正面看向镜头并直接对观众说话，脸、眼睛和上半身始终朝向镜头，保持口型清楚可读，稳定在${speakerSide}`
        : listeners.length
          ? `面向人物 ${listenerText}，${authoredFacing ? `${authoredFacing}，` : ""}呈现可读的四分之三侧脸，稳定在${speakerSide}`
          : authoredFacing
            ? `${authoredFacing}，保持脸部和口型清楚可读，稳定在${speakerSide}`
            : `面向既定视线目标，呈现可读的四分之三侧脸，稳定在${speakerSide}`;
      const dialogue = `<d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d>`;
      const mouthContract = turn?.onScreen === false
        ? `人物 ${speaker.label}位于画外；画面内所有人物全程闭口，只对声音作可见反应`
        : listeners.length
          ? `仅人物 ${speaker.label}${speakerSubject ? `（${speakerSubject}）` : ""}开口并驱动口型；人物 ${listenerText}全程闭口，${reaction}`
          : `仅人物 ${speaker.label}${speakerSubject ? `（${speakerSubject}）` : ""}开口并驱动口型；画面内不存在其他说话人物，其他可见嘴部全部保持闭口`;
      lines.push(`镜头 ${index + 1}，时间 ${time}，${cameraLead}；${authoredAction}${stateBefore ? `，从“${stateBefore}”开始` : ""}${stateAfter ? `，推进到“${stateAfter}”` : ""}${segmentDetails ? `；${segmentDetails}` : ""}。人物 ${speaker.label}${faceDirection}，${audio ? `声线仅参考${audio}，` : `由该人物依据本句准确文本原生发声，`}${dialogue}，以“${tone}”的语气和声调完整说一遍；${expression}；${body}。${mouthContract}。镜头执行：${authoredCamera}。`);
    } else {
      const visible = characterIds.map(id => integratedCharacter(project, id).label).filter(Boolean).join("、") || "画面内人物";
      lines.push(`镜头 ${index + 1}，时间 ${time}，${framing}；${authoredCamera}；${authoredAction}${stateBefore ? `，从“${stateBefore}”开始` : ""}${stateAfter ? `，推进到“${stateAfter}”` : ""}${segmentDetails ? `；${segmentDetails}` : ""}。本时段无对白，人物 ${visible}全部闭口，只依靠呼吸、眼神、表情、肢体动作和画面可见来源声完成剧情。`);
    }
  });
  lines.push(`整段 ${Number(duration).toFixed(1)} 秒视频内，每个核心人物始终是唯一、连续的同一个体，背景群像彼此独立；人物五官、年龄、发型、服装、声线归属、场景空间、光线、左右/前后站位、朝向、视线轴、道具与商品持有关系保持连续；只有上文每句明确列出的对白块可以被人物说出，其他时间码、动作、场景、表情、语气、运镜和参考绑定均为静默导演指令。只保留连续现场环境声、逐字对白和画面可见动作的同步声音。${HAILUO_INTEGRATED_OUTPUT_LOCK_ZH}`);
  return lines.join("\n").trim();
}

function buildEditedFullReferencePrompt(project, shot, references, bindings, duration) {
    const edit = shot.finalPromptEditing;
    const native=['text_to_video','image_to_video'].includes(references.hailuoApiMode);
    // In this authored block `product` is the canonical asset ID. Bind it only
    // here, not in shared policy prose, and never touch an exact dialogue tag.
    const productRole = list(references.imageRoles).find(role=>clean(role.type)==='product');
    const productSubject = productRole && bindings.subjects.get(`product:${clean(productRole.entityId||productRole.productId)}`);
    // Narrative nouns are prose, not machine identifiers: "product information
    // sheet" is not the original package. Typed references bind identity below.
    const authoredBody = String(edit.detailedDescriptionEn);
    const body = authoredBody.split(/\r?\n/).map(line=>bindProviderCueSubjects(line,bindings,references)).join('\n');
    const modeText = temporalContract(project, shot, references).replace(/^temporal_contract:\s*/, '');
    const verbosePolicy = 'Only the authored Chinese dialogue enclosed by the dialogue tags above is spoken, once and complete; all other text is silent direction. Every person, product and prop remains one unique physical instance; preserve identity, age, current wardrobe, location geometry, light, screen direction and the 180-degree eyeline axis unless the authored camera explicitly establishes a motivated change. Holder and physical state follow the exact authored changes, never freeze a prop in its reference pose. No graphic overlays or non-diegetic writing; retain source-authored physical marks; preserve original physical packaging and its printing.';
    const concisePolicy = 'Speak only tagged dialogue, once and completely. Keep each person and object unique; preserve original packaging and printing.';
    let rendered = [
      'subject_definitions:', ...bindings.definitions, '',
      'summary:', `[${officialReferenceTaskTypes(references)}] ${bindProviderCueSubjects(edit.summaryEn, bindings, references)}`,
      `Target length ${duration} seconds, ${clean(project.generation?.aspectRatio || '9:16')}, live-action.`, '',
      'retention_analysis:', ...bindings.retention, '',
      'detailed_description:', HAILUO_FINAL_OUTPUT_LOCK,
      native ? '' : modeText, body,
      native
        ? 'Only tagged dialogue is spoken. Every person, product and prop remains one unique physical instance; preserve original physical packaging and its printing.'
        : verbosePolicy, '',
      'overall_soundscape:', bindProviderCueSubjects(edit.soundscapeEn, bindings, references),
      'Sync each physical sound once to its contact, below dialogue. One voice at a time; clean onset/full final syllable; no pre-roll, mouth clicks or overlap.', '',
      'non_diegetic_music:', 'N/A'
    ].filter(value=>value!==undefined).join('\n').trim();
    // Binding C-IDs to official subjects expands word count after editorial
    // validation. Compact only this compiler-owned policy, never actor text,
    // dialogue, timings or actions. A genuinely long body still fails review.
    const detail=rendered.split('detailed_description:')[1]?.split('overall_soundscape:')[0]?.replace(/<d>[\s\S]*?<\/d>/gi,'')||'';
    if((detail.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]).length>500)rendered=rendered.replace(verbosePolicy,concisePolicy);
    return require('./reference-rule-compaction').compact(rendered);
}

function buildOfficialCompactFullReferencePrompt({ project = {}, shot = {}, references = {}, dialogueTurns = [], qualityRepair = "", spec = null }) {
  const duration = Math.max(1, Math.min(15, Number(shot?.duration) || 10));
  const turns = list(dialogueTurns).filter(turn => clean(turn?.text || turn?.spokenText));
  if (!turns.length) references = { ...references, audios: [], videoAudios: [] };
  const characterIds = unique([
    ...list(shot?.characterIds),
    ...list(shot?.visibleCharacterIds),
    ...turns.flatMap(turn => [turn?.speakerId || turn?.speaker, ...list(turn?.listenerIds)])
  ]);
  const bindings = referenceBindings(references, characterIds, turns, project, shot);
  if (require('./h3-final-prompt-editor').current(shot)) {
    return buildEditedFullReferencePrompt(project,shot,references,bindings,duration);
  }
  const planned = (list(shot?.subshots).length ? list(shot.subshots) : [{ number: 1, start: 0, end: duration }]).map(segment => ({ ...segment }));
  const compiled = list(spec?.subshots);
  // A compiled spec is still subject to the same speech clock as the normal
  // route. Equal visual slots are not valid dialogue duration estimates.
  const timedTurns = turns.map(turn => {
    const metadata = turn?.metadata || {};
    const segment = planned[Math.max(0, (Number(turn?.subshotNumber) || 1) - 1)] || planned[0];
    return {
      ...turn,
      delivery: [turn.delivery, turn.sourceTone, metadata.delivery, metadata.tone, metadata.volume, metadata.pace, turn.emotion, metadata.emotion].filter(Boolean).join("; "),
      start: turn.start ?? turn.startSecond ?? segment.start,
      end: turn.end ?? turn.endSecond ?? segment.end
    };
  });
  const timing = dialogueTimingPlan(timedTurns, duration);
  const windows = timing.slots;
  const windowByTurn = new Map(turns.map((turn, index) => [turn, windows[index]]));
  // Move existing visual boundaries with their speaking owner. Do not split a
  // physical beat and repeat its action, or leave the old camera cut inside a
  // newly lengthened line. Every authored action remains in its original order.
  for (let index = 1; index < planned.length; index += 1) {
    const firstTurnIndex = turns.findIndex(turn => (Number(turn?.subshotNumber) || 1) === index + 1);
    const priorTurnIndices = turns.map((turn, turnIndex) => ({ turn, turnIndex }))
      .filter(item => (Number(item.turn?.subshotNumber) || 1) < index + 1).map(item => item.turnIndex);
    const priorEnd = Math.max(0, ...priorTurnIndices.map(turnIndex => Number(windows[turnIndex]?.end) || 0));
    const boundary = firstTurnIndex >= 0
      ? Number(windows[firstTurnIndex]?.start)
      : Math.max(Number(planned[index].start) || 0, priorEnd);
    if (Number.isFinite(boundary) && boundary > Number(planned[index - 1].start) && boundary < duration) {
      planned[index - 1].end = boundary;
      planned[index].start = boundary;
    }
  }
  const bySubshot = new Map();
  turns.forEach(turn => {
    const number = Math.max(1, Number(turn?.subshotNumber) || 1);
    const bucket = bySubshot.get(number) || [];
    bucket.push(turn);
    bySubshot.set(number, bucket);
  });
  const shotLines = planned.map((segment, index) => {
    const number = index + 1;
    const start = Math.max(0, Number(segment?.start) || 0);
    const end = Math.min(duration, Number(segment?.end) || duration);
    const header = number === 1 ? "[Shot 1]" : `[Shot ${number}] At ${officialClockTimestamp(start)},`;
    const visible = unique(list(segment?.visibleCharacterIds).length ? segment.visibleCharacterIds : shot?.visibleCharacterIds)
      .map(id => bindings.ensureSubject(id)).filter(Boolean);
    const cast = visible.length
      ? (index === 0 ? `Each referenced identity is unique; visibility follows the authored entrance below.` : "The same referenced identities continue without duplication.")
      : "No person is visible.";
    // Chinese source fields must never shadow the approved English compilation.
    const authoredAction = bindProviderCueSubjects(deterministicEnglishCue(segment?.actionEn || compiled[index]?.visualEn || shot?.actionEn || segment?.action || shot?.action, "action", "Advance the authored physical state once", 720), bindings, references);
    const camera = bindProviderCueSubjects(deterministicEnglishCue(segment?.cameraEn || compiled[index]?.cameraEn || shot?.cameraMoveEn || segment?.camera || shot?.cameraMove, "camera", "Hold a stable story-focused camera on the established axis", 300), bindings, references);
    const sound = sanitizeUnauthoredVocalSound(bindProviderCueSubjects(deterministicEnglishCue(compiled[index]?.soundEn || segment?.soundEn || segment?.sound, "sound", "Continuous location room tone", 3000), bindings, references));
    const turnLines = list(bySubshot.get(number)).map((turn, turnIndex, segmentTurns) => {
      const speakerId = clean(turn?.speakerId || turn?.speaker);
      const speaker = bindings.ensureSubject(speakerId) || "the assigned speaker";
      const speakerNumber = bindings.speakerByCharacterId.get(speakerId) || `S${turnIndex + 1}`;
      const listeners = unique(turn?.primaryListenerId ? [turn.primaryListenerId] : turn?.listenerIds).map(id => bindings.ensureSubject(id)).filter(Boolean);
      const directToViewer=turn.directToViewer===true||/^(viewer|camera|audience)$/i.test(turn.addressMode||'');
      const listener = directToViewer ? 'the viewer through the lens' : listeners[0] || "the established listener";
      const metadata = turn?.metadata || {};
      const window = windowByTurn.get(turn);
      const globalTurnIndex = turns.indexOf(turn);
      const inferredTone = inferDialogueTone({
        text: turn?.text || turn?.spokenText,
        explicitTone: turn?.deliveryEn || metadata?.deliveryEn || timedTurns[globalTurnIndex]?.delivery || turn?.vocalArcEn || metadata?.vocalArcEn,
        action: shot?.action || shot?.visualBeat || shot?.performance,
        previousText: turns[globalTurnIndex - 1]?.text,
        nextText: turns[globalTurnIndex + 1]?.text
      });
      const delivery = sanitizeExactDialoguePerformance(productionCue(inferredTone, "delivery", "emotionally specific delivery with clear stress and breath", 220))
        .replace(/slower ending/g, "controlled final stress without stretching syllables")
        .replace(/tearful breath, trembling tail/g, /心虚/.test(inferredTone) && !/哭|颤|哽咽/.test(inferredTone) ? "tight uneasy breath, guarded final stress" : "tearful breath, trembling tail");
      const authoredEmotion = /声嘶力竭|嘶吼/.test(inferredTone) ? "strained forceful projection, cracking pressure and sharp stressed words" : "";
      const vocalArc = metadataCue(turn?.vocalArcEn || metadata?.vocalArcEn, "audible volume, pitch, keyword stress and breath follow the emotional progression", 220);
      const reactionCue = bindProviderCueSubjects(englishOnly(turn?.listenerReactionEn || metadata?.listenerReactionEn || turn?.listenerBeatEn || metadata?.listenerBeatEn, 'reacts visibly without speaking', 80), bindings, references);
      const nonSpeakers = visible.filter(subject => subject !== speaker);
      const reaction = `${nonSpeakers.length ? nonSpeakers.join(' and ') + ' remains closed-lipped and reacts visibly' : 'Every listener keeps lips at rest and reacts visibly'}; ${reactionCue}`;
      const voiceReference = bindings.audioByCharacterId.get(speakerId);
      const cut = turn?.onScreen !== false && globalTurnIndex > 0 && clean(turns[globalTurnIndex - 1]?.speakerId || turns[globalTurnIndex - 1]?.speaker) !== speakerId
        ? `At ${preciseSecondTimestamp(window.start)} seconds, cut to ${speaker}'s established visible speaking face without changing that person's identity. ` : "";
      const voiceClause = voiceReference ? ` using only the vocal identity of ${voiceReference}` : "";
      if (turn?.onScreen === false) {
        return `${cut}From ${preciseSecondTimestamp(window.start)} to ${preciseSecondTimestamp(window.end)} seconds, ${speaker} (${speakerNumber}) remains off-screen and speaks once${voiceClause}: <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> Deliver at no less than ${speechRatePolicy(timedTurns[globalTurnIndex]).minCps} effective Chinese characters per second: ${[authoredEmotion, delivery].filter(Boolean).join("; ")}; vocal arc is ${vocalArc}. No visible mouth moves for this line; ${reaction}; every on-screen mouth stays closed. Finish inside this window without revealing, reflecting, or materializing the off-screen speaker.`;
      }
      return `${cut}From ${preciseSecondTimestamp(window.start)} to ${preciseSecondTimestamp(window.end)} seconds, ${speaker} (${speakerNumber}) faces ${listener} and speaks once${voiceClause}, ${directToViewer?'in the explicitly authored front-facing viewer address':'in a readable three-quarter view and never toward the camera'}: <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> Deliver at no less than ${speechRatePolicy(timedTurns[globalTurnIndex]).minCps} effective Chinese characters per second: ${[authoredEmotion, delivery].filter(Boolean).join("; ")}; vocal arc is ${vocalArc}. Only ${speaker} (${speakerNumber}) moves the lips for this line; ${reaction}; all other mouths stay closed. Finish inside this window.`;
    });
    return `${header} From ${preciseSecondTimestamp(start)} to ${preciseSecondTimestamp(end)} seconds, ${cast} ${authoredAction.replace(/[.!?]+$/g, "")}. Camera: ${camera.replace(/[.!?]+$/g, "")}. ${turnLines.join(" ")}${sound ? ` Sound: ${sound.replace(/[.!?]+$/g, "")}.` : ""}`;
  });
  const summary = bindProviderCueSubjects(englishOnly(spec?.summaryEn || shot?.summaryEn || shot?.visualBeatEn || shot?.actionEn, "One causal dramatic action changes the visible power state", 330), bindings, references);
  const overallSoundscape = sanitizeUnauthoredVocalSound(bindProviderCueSubjects(
    englishOnly(spec?.overallSoundscapeEn, "Continuous natural location ambience and only synchronized visible-source physical sounds continue through the final frame", 360),
    bindings,
    references
  ));
  const aspect = clean(project?.generation?.aspectRatio || "9:16");
  return [
    "subject_definitions:",
    ...(bindings.definitions.length ? bindings.definitions : ["No unbound principal subject may be invented for this clip."]),
    "",
    "summary:",
    `[${officialReferenceTaskTypes(references)}] ${summary} Target length ${duration.toFixed(2)} seconds, ${aspect}, live-action.`,
    "",
    "retention_analysis:",
    ...(bindings.retention.length ? bindings.retention : ["<Subject 1>: fully_preserved - preserve the authored physical state and continuity role."]),
    "",
    "detailed_description:",
    HAILUO_FINAL_OUTPUT_LOCK,
    "From 0.0 to 0.30 seconds all mouths remain closed; continuous quiet location ambience begins immediately with no vocal pre-roll. Protect the final syllable and a clean non-vocal reaction tail.",
    ...shotLines,
    bindProviderCueSubjects(physicalContinuityDirections(project, shot), bindings, references),
    "Keep every identity unique; preserve wardrobe, screen side, depth, and the 180-degree axis. Never restart, teleport, duplicate, or swap bodies.",
    turns.length ? `Speak only the ${turns.length === 1 ? "one tagged Chinese line" : `${turns.length} tagged Chinese lines`}, each once and complete, with no false start, lip smack, overlap, echo, or invented word.` : "No dialogue or vocalization occurs; every mouth stays closed.",
    qualityRepair ? "Correct the prior technical failure while preserving the authored dialogue, action order, reference bindings, and final state." : "",
    "",
    "overall_soundscape:",
    `${overallSoundscape} ${bindProviderCueSubjects(sourceSoundTimeline(shot, planned), bindings, references)} At any instant no more than one authored speaker is audible; non-speakers and background figures remain vocally silent, without muting authored physical sound.`,
    "",
    "non_diegetic_music:",
    "N/A"
  ].filter(line => line !== "").join("\n").trim();
}

function buildApprovedHailuoPrompt(options = {}) {
  let prompt = buildApprovedHailuoPromptInternal(options);
  const {project = {}, shot = {}, references = {}, dialogueTurns = []} = options;
  if(project.productionPlan?.simpleAssetOnly===true){
    const full=require('./manual-direction-translation').completeDirections(project,shot);
    if(full)prompt+='\n\nSource-authored physical directions, describing the same once-only events above; retain their complete causal order and never repeat an action:\n'+full;
  }
  if (!["text_to_video", "image_to_video"].includes(references.hailuoApiMode)) return prompt;
  const canonical = canonicalizeStagingShot(project, shot, dialogueTurns);
  const ids = unique([...list(canonical.shot.characterIds), ...list(canonical.shot.visibleCharacterIds), ...canonical.turns.flatMap(t=>[t.speakerId,...list(t.listenerIds)])]);
  return require('./h3-native-prompt').nativePrompt({prompt, project, shot:canonical.shot, references,
    bindings:referenceBindings(references, ids, canonical.turns, project, canonical.shot)});
}

function buildApprovedHailuoPromptInternal({ project = {}, shot = {}, references = {}, dialogueTurns = [], qualityRepair = "", spec = null, priorityProfile = "" }) {
  const canonical = canonicalizeStagingShot(project, shot, dialogueTurns);
  shot = canonical.shot;
  dialogueTurns = canonical.turns;
  // All compiler routes, including cached specVersion, share the same actual
  // reference preconditions. The spec fast path used to bypass this entirely.
  const required = unique(dialogueTurns.filter(turn => !isOffscreen(turn, project)).map(turn => turn.speakerId));
  const actual = list(references.imageRoles).filter(role => role.type === "character").map(role => clean(role.entityId || role.characterId));
  const independent = clean(references.hailuoApiMode) === "reference_to_video" || /(?:asset_direct|production_package)/.test(clean(references.promptMode || references.videoStrategy || shot.videoStrategy || project.generation?.mode));
  const composed = list(references.imageRoles).some(role => role.type === "shot_anchor" && required.every(id => list(role.coversEntityIds).includes(id)));
  if (independent && !composed && (actual.some((id, index) => actual.indexOf(id) !== index) || required.some(id => !actual.includes(id)))) {
    throw Object.assign(new Error("H3 character identity reference contract is ambiguous before submission"), { code: "HAILUO_CHARACTER_REFERENCE_BIJECTION_FAILED", missingVisibleSpeakerReferences: required.filter(id => !actual.includes(id)), duplicateCharacterReferences: actual.filter((id, index) => actual.indexOf(id) !== index) });
  }
  if (spec?.specVersion) {
    return buildOfficialCompactFullReferencePrompt({ project, shot, references, dialogueTurns, qualityRepair, spec });
  }
  const duration = Math.max(10, Math.min(15, Number(shot?.duration) || 12));
  const turns = list(dialogueTurns).filter(turn => clean(turn?.text || turn?.spokenText));
  const dialogueFirstPriority = turns.length > 0;
  // A silent shot must remain a pure action/ambience request. Character IDs
  // still anchor visual continuity, but they must not implicitly promote voice
  // references into the final provider payload.
  if (!turns.length) references = { ...references, audios: [], videoAudios: [] };
  const characterIds = unique([
    ...list(shot?.characterIds),
    ...list(shot?.visibleCharacterIds),
    ...turns.flatMap(turn => [turn?.speakerId || turn?.speaker, ...list(turn?.listenerIds)])
  ]);
  const bindings = referenceBindings(references, characterIds, turns, project, shot);
  const characterReferenceIds = list(references?.imageRoles)
    .filter(role => clean(role?.type) === "character")
    .map(role => clean(role?.entityId || role?.characterId));
  const requiredVisibleSpeakerIds = unique(turns
    .filter(turn => {
      if (turn?.onScreen === false) return false;
      const speakerId = clean(turn?.speakerId || turn?.speaker);
      const character = list(project?.characters).find(item => clean(item?.id || item?.name) === speakerId);
      return character?.offscreenOnly !== true;
    })
    .map(turn => clean(turn?.speakerId || turn?.speaker)));
  const duplicateCharacterReferences = characterReferenceIds.filter((id, index) => id && characterReferenceIds.indexOf(id) !== index);
  const missingVisibleSpeakerReferences = requiredVisibleSpeakerIds.filter(id => !characterReferenceIds.includes(id));
  const requiresIndependentCharacterReferences = clean(references?.hailuoApiMode) === "reference_to_video"
    || /(?:asset_direct|production_package)/.test(clean(references?.promptMode || references?.videoStrategy || shot?.videoStrategy || project?.generation?.mode));
  if (requiresIndependentCharacterReferences && (duplicateCharacterReferences.length || missingVisibleSpeakerReferences.length)) {
    throw Object.assign(new Error("H3 character identity reference contract is ambiguous before submission"), {
      code: "HAILUO_CHARACTER_REFERENCE_BIJECTION_FAILED",
      duplicateCharacterReferences: unique(duplicateCharacterReferences),
      missingVisibleSpeakerReferences
    });
  }
  const timing = dialogueTimingPlan(turns, duration);
  if (require('./h3-final-prompt-editor').current(shot)) {
    return buildEditedFullReferencePrompt(project,shot,references,bindings,duration);
  }
  let visualSegments = timedVisualSegments(spec || {}, shot, turns, duration)
    .map((segment, timelineSourceIndex) => ({ ...segment, timelineSourceIndex }));
  const inferredWindowPlan = inferredDialogueWindowsFromAuthoredSegments(project, shot, turns, visualSegments, timing, duration);
  // Establish a scene-stable axis from the project's cast order, then honor
  // explicit authored blocking. Never derive screen side from shot number,
  // event number, speaker order, or a per-shot character-array permutation.
  const stableBlockingOrder = unique([
    ...list(project?.characters).map(character => clean(character?.id || character?.name)),
    ...characterIds.map(id => clean(id))
  ]).filter(Boolean);
  const defaultSceneSides = ["screen-left", "screen-right", "screen-center", "deep screen-left", "deep screen-right"];
  const screenSideByCharacterId = new Map(stableBlockingOrder.map((id, index) => [
    id,
    defaultSceneSides[Math.min(index, defaultSceneSides.length - 1)]
  ]));
  list(project?.characters).forEach(character => {
    const id = clean(character?.id || character?.name);
    const side = authoredScreenSide(character?.screenSide || character?.blockingEn || character?.blocking, id, character?.name);
    if (id && side) screenSideByCharacterId.set(id, side);
  });
  castRows(shot).forEach(row => {
    const id = clean(row.characterId || row.id);
    const side = authoredScreenSide(row.screenSide, id);
    if (id && side) screenSideByCharacterId.set(id, side);
  });
  turns.forEach(turn => {
    const id = clean(turn?.speakerId || turn?.speaker);
    const metadata = turn?.metadata || {};
    const side = authoredScreenSide(turn?.screenSide || metadata?.screenSide || turn?.blockingEn || metadata?.blockingEn || turn?.speakerFacingEn || metadata?.speakerFacingEn || turn?.bodyActionEn || metadata?.bodyActionEn, id, turn?.speaker);
    if (id && side) screenSideByCharacterId.set(id, side);
  });
  let lastDialogueEnd = 0;
  const dialogueBodyCues = [];
  const resolvedDialogueWindows = [];
  const dialogueVisualCues = [];
  const treatmentOwnershipContracts = [];
  const dialogueDescriptions = turns.map((turn, index) => {
    const window = inferredWindowPlan.windows[index] || exactTurnWindow(turn, index, timing, duration);
    resolvedDialogueWindows.push(window);
    lastDialogueEnd = Math.max(lastDialogueEnd, Number(window.end) || 0);
    const speakerId = clean(turn?.speakerId || turn?.speaker);
    const speaker = bindings.ensureSubject(speakerId) || "assigned speaker";
    const stableSpeakerId = bindings.speakerByCharacterId.get(speakerId) || `S${index + 1}`;
    const listeners = unique(turn?.primaryListenerId ? [turn.primaryListenerId] : turn?.listenerIds).map(listenerId => {
      const subject = bindings.ensureSubject(listenerId);
      return subject || providerStableId(listenerId, "listener");
    }).filter(Boolean);
    const audio = bindings.audioByCharacterId.get(speakerId);
    const metadata = turn?.metadata || {};
    // Preserve the full translated delivery cue.  A 30-character cap cut
    // "restrained anger, clipped stress" after the comma, dropping the
    // authored stress instruction from the final video prompt.
    const inferredTone = inferDialogueTone({
      text: turn?.text || turn?.spokenText,
      explicitTone: turn?.deliveryEn || metadata?.deliveryEn || turn?.sourceTone || metadata?.delivery || metadata?.tone || turn?.performanceEn,
      action: shot?.action || shot?.visualBeat || shot?.performance,
      scene: shot?.scene || shot?.sceneName,
      previousText: turns[index - 1]?.text || turns[index - 1]?.spokenText,
      nextText: turns[index + 1]?.text || turns[index + 1]?.spokenText
    });
    const delivery = sanitizeExactDialoguePerformance(bindProviderCueSubjects(
      productionCue(inferredTone, "delivery", "emotionally specific Chinese delivery", 150),
      bindings,
      references
    ));
    const body = bindProviderCueSubjects(
      productionCue(turn?.bodyActionEn || metadata?.bodyActionEn || turn?.bodyEn || metadata?.bodyEn || metadata?.body || turn?.body, "body", "face and body follow the authored intent", 220),
      bindings,
      references
    );
    const expression = sanitizeExactDialoguePerformance(bindProviderCueSubjects(productionCue(
      turn?.facialPerformanceEn || metadata?.facialPerformanceEn || turn?.expressionArcEn || metadata?.expressionArcEn || turn?.expressionEn || turn?.faceEn || metadata?.expressionEn || metadata?.faceEn || turn?.performanceEn
        || turn?.emotionPeak || metadata?.emotionPeak || turn?.emotionStart || metadata?.emotionStart,
      "reaction",
      "eyes, brows, breath, jaw and micro-expression visibly travel from the line's opening emotion through its pressure point to its final aftershock",
      240
    ), bindings, references));
    const vocalArc = sanitizeExactDialoguePerformance(bindProviderCueSubjects(metadataCue(
      turn?.vocalArcEn || metadata?.vocalArcEn,
      "audible volume, pitch contour, pace, pauses, keyword stress and breath follow the line's emotional progression",
      300
    ), bindings, references));
    // Multi-person treatment actions are especially prone to recipient drift:
    // "massage both temples" can be rendered on the acting helper instead of
    // the listener.  Carry the actor, patient and anatomical ownership in the
    // provider text itself so H3 never has to resolve a dangling body part.
    const treatmentContext = bindProviderCueSubjects([
      shot?.actionEn,
      shot?.action,
      shot?.visualBeatEn,
      shot?.visualBeat
    ].filter(Boolean).join("; "), bindings, references);
    const treatmentBody = hasRecipientTreatmentAction(body);
    const selfOwnedBodyPart = new RegExp(`${regexEscape(speaker)}(?:'s)?\\s+(?:own\\s+)?(?:hair|head|temples?|roots?|scalp|face|collar|sleeves?|lapels?|shoulders?|arms?|hands?|back)`, "i").test(body);
    const contextualRecipient = listeners.length === 1
      && treatmentContext.includes(speaker)
      && treatmentContext.includes(listeners[0])
      && (
        new RegExp(`${regexEscape(speaker)}[\\s\\S]{0,220}\\b(?:appl|massag|rubb|rub|brush|comb|wash|dy|treat|wip|clean|bandag|dress)[a-z]*\\b[\\s\\S]{0,220}${regexEscape(listeners[0])}`, "i").test(treatmentContext)
        || new RegExp(`${regexEscape(listeners[0])}[\\s\\S]{0,120}\\b(?:receiv|patient|recipient|is treated)[a-z]*\\b`, "i").test(treatmentContext)
      );
    const recipientSensitiveAction = listeners.length === 1
      && treatmentBody
      && !selfOwnedBodyPart
      && (body.includes(listeners[0]) || contextualRecipient);
    const recipientBoundBody = recipientSensitiveAction
      ? `${body}; ${speaker} performs the authored treatment with both hands on ${listeners[0]}, and every named hair, temple, root, scalp, face, garment part, or body part in this action belongs to ${listeners[0]}`
      : body;
    if (recipientSensitiveAction) {
      treatmentOwnershipContracts.push({ actor: speaker, recipient: listeners[0] });
    }
    dialogueBodyCues.push(recipientBoundBody);
    const monologueContext = clean([
      shot?.scene,
      shot?.sceneName,
      shot?.action,
      shot?.actionEn,
      shot?.visualBeat,
      shot?.visualBeatEn
    ].filter(Boolean).join(" "));
    const directToViewer = turn?.directToViewer === true
      || metadata?.directToViewer === true
      || /^(?:viewer|camera|audience)$/i.test(clean(turn?.addressMode || metadata?.addressMode));
    const address = directToViewer
      ? "the viewer through the lens"
      : listeners.length
        ? listeners.join(" and ")
        : /mirror|reflection|鏡|镜/.test(monologueContext)
          ? "the mirror directly in front of them"
          : "the established focal point in the scene";
    const speakerSide = screenSideByCharacterId.get(speakerId) || "the established screen side";
    const listenerSide = clean(turn?.listenerIds?.[0])
      ? (screenSideByCharacterId.get(clean(turn.listenerIds[0])) || "the opposite established screen side")
      : "the established focal direction";
    const blocking = bindProviderCueSubjects(metadataCue(
      turn?.blockingEn || metadata?.blockingEn || turn?.positionEn || metadata?.positionEn,
      `${speaker} holds ${speakerSide}; ${listeners[0] || "the focal point"} holds ${listenerSide}; preserve their established distance, foreground/background depth and unobstructed faces`,
      320
    ), bindings, references);
    const facing = directToViewer
      ? `${speaker}'s face, eyes and upper torso stay front-facing toward the lens; keep the speaking mouth fully readable and hold the bound product clearly beside the face`
      : bindProviderCueSubjects(metadataCue(
        turn?.speakerFacingEn || metadata?.speakerFacingEn || turn?.eyelineEn || metadata?.eyelineEn,
        `${speaker}'s face, eyes and upper torso point toward ${address}, never toward the camera; keep a readable three-quarter speaking face and stay on the same side of the 180-degree eyeline axis`,
        320
      ), bindings, references);
    const listenerReaction = sanitizeExactDialoguePerformance(bindProviderCueSubjects(productionCue(
      turn?.listenerReactionEn || metadata?.listenerReactionEn || turn?.listenerBeatEn || metadata?.listenerBeatEn || turn?.listenerBeat || metadata?.listenerBeat,
      "reaction",
      "the listener keeps resting lips and gives a specific synchronized eye, breath, jaw or weight-shift reaction to the meaning of the line",
      260
    ), bindings, references));
    const visibleSpeech = turn?.onScreen !== false;
    const voiceBinding = audio ? ` using only the vocal identity of ${audio}` : "";
    // The official H3 gateway rejects prompts above 10,000 characters. Keep
    // every performance dimension, but bound prose inside each dimension so a
    // rich two-speaker shot cannot cross that provider contract. Dialogue text
    // itself is appended separately and is never shortened here.
    const performance = [
      `delivery is ${englishOnly(delivery, "emotionally specific Chinese delivery", 82)}`,
      `vocal arc is ${englishOnly(vocalArc, "audible pace, stress and breath follow the emotional progression", 360)}`,
      `facial arc is ${englishOnly(expression, "eyes, brows, jaw and micro-expression carry the emotional progression", 360)}`,
      `body action is ${englishOnly(recipientBoundBody, "face and body follow the authored intent", 260)}`,
      `blocking is ${englishOnly(blocking, `${speaker} holds the established screen side`, 220)}`,
      `facing and eyeline are ${englishOnly(facing, `${speaker} faces ${address}`, 220)}`
    ].join("; ");
    const priorityPerformance = {
      tone: `delivery is ${englishOnly(delivery, "emotionally specific Chinese delivery", 150)}; vocal arc is ${englishOnly(vocalArc, "audible pace, stress and breath follow the emotional progression", 300)}`,
      emotion: `facial arc is ${englishOnly(expression, "eyes, brows, jaw and micro-expression carry the emotional progression", 300)}; listener reaction is ${englishOnly(listenerReaction, "the listener stays closed-lipped and reacts visibly", 240)}`,
      action: `body action is ${englishOnly(recipientBoundBody, "face and body follow the authored intent", 220)}`,
      blocking: `blocking is ${englishOnly(blocking, `${speaker} holds the established screen side`, 200)}; facing and eyeline are ${englishOnly(facing, `${speaker} faces ${address}`, 200)}`
    };
    const nonSpeakingVisible=unique(shot.visibleCharacterIds||shot.characterIds).filter(id=>id!==speakerId).map(id=>bindings.ensureSubject(id)).filter(Boolean);
    const listenerMouthLock = nonSpeakingVisible.length
      ? `${nonSpeakingVisible.join(" and ")} remains closed-lipped and reacts visibly${dialogueFirstPriority ? "" : `; listener reaction is ${listenerReaction}`}`
      : "no other visible mouth moves or inherits any part of the line";
    const sourceSegmentIndex = overlappingSegmentIndex(visualSegments, turn);
    dialogueVisualCues.push({
      index,
      window,
      speakerId,
      speaker,
      visibleSpeech,
      listeners,
      body: recipientBoundBody,
      blocking,
      facing,
      listenerReaction,
      authoredWindow: Number.isFinite(Number(turn?.start ?? turn?.startSecond))
        && Number.isFinite(Number(turn?.end ?? turn?.endSecond)),
      sourceSegmentIndex,
      sourceSegment: sourceSegmentIndex >= 0 ? { ...visualSegments[sourceSegmentIndex] } : null
    });
    if (!visibleSpeech) {
      if (dialogueFirstPriority) {
      return `From ${timestamp(window.start)} to ${timestamp(window.end)} seconds, ${speaker} (${stableSpeakerId}) remains off-screen and says exactly once${voiceBinding}, <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> The line is complete before the window ends at no less than ${speechRatePolicy(turn).minCps} effective Chinese characters per second, with no false start, restart, trailing syllable, or cut-off word. ${priorityPerformance.tone}. The voice has no visible face or body in this view. No visible mouth moves; ${address} reacts with closed lips while the camera preserves the authored blocking. Do not transfer the remote voice to any visible person or reveal its speaker.`;
      }
      return `From ${timestamp(window.start)} to ${timestamp(window.end)} seconds, ${speaker} (${stableSpeakerId}) remains outside the frame and speaks once${voiceBinding} while ${address} stays visible and reacts; ${performance}: <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> No visible mouth moves during this off-camera line.`;
    }
    const cameraSpeakerLock = listeners.length
      ? `Throughout this window the camera reads ${speaker}'s face and mouth as the sole active speaking face; ${listeners.join(" and ")} remains closed-lipped and reacts visibly.`
      : `Throughout this window the camera reads ${speaker}'s face and mouth as the sole active speaking face.`;
    if (dialogueFirstPriority) {
      return `From ${timestamp(window.start)} to ${timestamp(window.end)} seconds, ${speaker} (${stableSpeakerId}) faces ${address} and says exactly once${voiceBinding}, <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> The line is complete before the window ends at no less than ${speechRatePolicy(turn).minCps} effective Chinese characters per second, with no false start, restart, trailing syllable, or cut-off word. ${priorityPerformance.tone}. ${priorityPerformance.emotion}. ${priorityPerformance.action}. ${priorityPerformance.blocking}. Only ${speaker} (${stableSpeakerId}) moves the lips for this line; after the final syllable the mouth closes, while ${listenerMouthLock}.`;
    }
    return `From ${timestamp(window.start)} to ${timestamp(window.end)} seconds, ${speaker} (${stableSpeakerId}) faces ${address} and speaks once${voiceBinding}; ${performance}: <d>[Chinese] ${clean(turn?.text || turn?.spokenText)}</d> ${cameraSpeakerLock} Only ${speaker} (${stableSpeakerId}) moves the lips for this line; ${listenerMouthLock}; ${speaker} closes the mouth after the final syllable.`;
  });
  const speakerCutTimes = dialogueSpeakerCutTimes(turns, resolvedDialogueWindows);
  const visualBoundaryTimes = resolvedDialogueWindows.slice(1).map(window => Number(window.start)).filter(Number.isFinite);
  if (visualSegments.length && timing.speechSpan > 0.05 && timing.speechSpan < duration - 0.05) {
    visualBoundaryTimes.push(timing.speechSpan);
  }
  if (!timing.authoredTimingAdequate && !inferredWindowPlan.used) {
    visualSegments = alignVisualSegmentsToSpeakerCuts(visualSegments, visualBoundaryTimes, duration);
    visualSegments = reconcileReflowedDialogueVisuals(visualSegments, dialogueVisualCues, timing, duration);
  }
  visualSegments = completeMasterActionCoverage(shot, visualSegments, turns, dialogueBodyCues);
  visualSegments = visualSegments.map(segment => ({
    ...segment,
    action: bindProviderCueSubjects(segment.action, bindings, references),
    camera: bindProviderCueSubjects(segment.camera, bindings, references),
    before: bindProviderCueSubjects(segment.before, bindings, references),
    after: bindProviderCueSubjects(segment.after, bindings, references),
    blocking: bindProviderCueSubjects(segment.blocking, bindings, references),
    backgroundAction: sanitizeSilentBackgroundDirection(bindProviderCueSubjects(segment.backgroundAction, bindings, references)),
    sound: sanitizeUnauthoredVocalSound(bindProviderCueSubjects(segment.sound, bindings, references))
  }));
  if (treatmentOwnershipContracts.length) {
    const { actor, recipient } = treatmentOwnershipContracts[0];
    const ownership = `The treatment recipient is ${recipient}; ${actor}'s hands apply the material only to ${recipient}'s named hair, temples, roots or scalp, while ${actor}'s own hair remains in its prior untreated state`;
    visualSegments = visualSegments.map(segment => {
      const treatmentAction = /\b(?:appl|massag|rubb|rub\b|brush|comb|wash|dy|treat)[a-z]*\b[\s\S]*\b(?:hair|head|temples?|roots?|scalp|foam)\b/i.test(segment.action || "");
      return {
        ...segment,
        action: treatmentAction && !String(segment.action || "").includes("The treatment recipient is")
          ? `${String(segment.action || "").replace(/[.!?]+$/g, "")}; ${ownership}`
          : segment.action,
        after: segment.after
      };
    });
  }
  // Dialogue timing can push a legacy visual subdivision onto the exact end
  // boundary, leaving 0.0-0.2 second pseudo-shots. They add an impossible cut,
  // repeat state prose, and can push an otherwise valid official request over
  // the gateway limit. Fold only those micro-segments into the preceding beat
  // while retaining their action and final state.
  const coalescedVisualSegments = [];
  for (const segment of visualSegments) {
    const span = Math.max(0, Number(segment.end) - Number(segment.start));
    const previous = coalescedVisualSegments.at(-1);
    // A camera beat shorter than 0.8 seconds cannot reliably establish a
    // readable action state, preserve identity, and land a direct cut. Fold it
    // into the preceding beat instead of asking H3 to perform an unusable
    // flash-cut that also steals time from dialogue or physical action.
    if (previous && span < 0.8) {
      previous.end = Math.max(Number(previous.end) || 0, Number(segment.end) || 0);
      previous.action = unique([previous.action, segment.action]).join("; then ");
      previous.after = segment.after || previous.after;
      previous.backgroundAction = unique([previous.backgroundAction, segment.backgroundAction]).join("; then ");
      previous.sound = unique([previous.sound, segment.sound]).join("; then ");
      continue;
    }
    coalescedVisualSegments.push({ ...segment });
  }
  visualSegments = coalescedVisualSegments;
  if (!list(shot?.providerTimedDirections).length && visualSegments.length === 1) {
    let masterAction = bindProviderCueSubjects(
      deterministicEnglishCue(shot?.actionEn || shot?.visualBeatEn || shot?.action, "action", "", 360),
      bindings,
      references
    );
    if (masterAction && treatmentOwnershipContracts.length) {
      const { actor, recipient } = treatmentOwnershipContracts[0];
      const ownership = `The treatment recipient is ${recipient}; ${actor}'s hands apply the material only to ${recipient}'s named hair, temples, roots or scalp, while ${actor}'s own hair remains in its prior untreated state`;
      if (/\b(?:appl|massag|rubb|rub\b|brush|comb|wash|dy|treat)[a-z]*\b[\s\S]*\b(?:hair|head|temples?|roots?|scalp|foam)\b/i.test(masterAction)) {
        masterAction = `${masterAction.replace(/[.!?]+$/g, "")}; ${ownership}`;
      }
    }
    if (masterAction) visualSegments = [{ ...visualSegments[0], action: masterAction }];
  }
  // Legacy Agent plans sometimes repeated the complete block-level action in
  // every camera segment. H3 then receives three independent commands to walk,
  // hand over, kneel, close a prop, or otherwise restart the same action after
  // each cut. Preserve the complete action once, then make later camera beats
  // explicit continuation/completion phases of that one physical event.
  const repeatedActionCounts = new Map();
  for (const segment of visualSegments) {
    const key = clean(segment.action).toLowerCase().replace(/\s+/g, " ");
    if (key) repeatedActionCounts.set(key, (repeatedActionCounts.get(key) || 0) + 1);
  }
  const repeatedActionSeen = new Map();
  visualSegments = visualSegments.map((segment, index, allSegments) => {
    const originalAction = clean(segment.action);
    const key = originalAction.toLowerCase().replace(/\s+/g, " ");
    const count = repeatedActionCounts.get(key) || 0;
    if (!key || count < 2) return segment;
    const occurrence = (repeatedActionSeen.get(key) || 0) + 1;
    repeatedActionSeen.set(key, occurrence);
    if (occurrence === 1) {
      return {
        ...segment,
        action: originalAction
      };
    }
    if (occurrence === count) {
      return {
        ...segment,
        before: clean(segment.before) === clean(allSegments.find(item => clean(item.action).toLowerCase().replace(/\s+/g, " ") === key)?.before)
          ? allSegments[index - 1]?.after || segment.before : segment.before,
        action: "Complete the same single authored action from the prior physical state without restarting or replaying it"
      };
    }
    return {
      ...segment,
      before: clean(segment.before) === clean(allSegments.find(item => clean(item.action).toLowerCase().replace(/\s+/g, " ") === key)?.before)
        ? allSegments[index - 1]?.after || segment.before : segment.before,
      action: "Continue the same single authored action from the prior physical state without restarting it"
    };
  });
  const requestedMode = clean(references?.promptMode || references?.videoStrategy || shot?.videoStrategy || project?.generation?.mode).toLowerCase();
  const providerApiMode = clean(references?.hailuoApiMode).toLowerCase();
  const roles = list(references?.imageRoles);
  const startIndex = roles.findIndex(role => clean(role?.type) === "storyboard_start");
  const endIndex = roles.findIndex(role => clean(role?.type) === "storyboard_end");
  const sheetIndex = roles.findIndex(role => ["storyboard_sheet", "storyboard_generation_block_sheet", "storyboard_take_sheet"].includes(clean(role?.type)));
  const timelinePanels = roles.map((role, index) => ({ role, index })).filter(item => clean(item.role?.type) === "storyboard_timeline_panel");
  const videos = list(references?.videos).length ? list(references.videos) : (references?.video ? [references.video] : []);
  const previousVideoIndex = list(references?.videoRoles).findIndex(role => clean(role?.type) === "previous_shot");
  const mode = requestedMode.includes("asset_direct")
    ? "asset_direct"
    : requestedMode.includes("storyboard_sheet") || sheetIndex >= 0 || timelinePanels.length
      ? "storyboard_sheet"
      : requestedMode.includes("continuation") || previousVideoIndex >= 0
        ? "continuation"
        : "keyframe";
  const aspect = clean(project?.generation?.aspectRatio || "9:16");
  const soundDetails = sanitizeUnauthoredVocalSound(
    unique(visualSegments.flatMap(segment => clean(segment.sound).split(/;\s*then\s*/i))).join("; ")
  );
  const onScreenSpeakers = unique(turns
    .filter(turn => turn?.onScreen !== false)
    .map(turn => clean(turn?.speakerId || turn?.speaker)))
    .map(id => bindings.ensureSubject(id))
    .filter(Boolean);
  const ensembleContract = authoredEnsembleReaction(shot, visualSegments);
  const principalFramingContract = "framing: honor each authored camera beat; keep its speaker readable without cropping required listeners, entrances, hands or contact. Preserve the axis; no forced face close-up.";
  const framingContract = principalFramingContract;

  let modeDirective = "Reference assets lock identity, location, objects, product and wardrobe; begin at the authored before-state and end with the authored action visibly complete.";
  if (mode === "storyboard_sheet") {
    const frames = timelinePanels.length
      ? timelinePanels.map(({ index }) => `<Picture ${index + 1}>`).join(", ")
      : sheetIndex >= 0 ? `<Picture ${sheetIndex + 1}>` : "the supplied ordered narrative frames";
    modeDirective = `Follow ${frames} as an ordered temporal plan, carrying identity, space, props, action, and expression forward between frames.`;
  } else if (mode === "continuation") {
    modeDirective = videos.length
      ? `At 0.00 seconds continue directly from the final physical and acoustic state of <Video ${Math.max(0, previousVideoIndex) + 1}>, then advance to a new authored end state without replaying the prior action.`
      : `At 0.00 seconds begin at ${startIndex >= 0 ? `<Picture ${startIndex + 1}>` : "the authored opening state"}; execute the new causal action once and reach ${endIndex >= 0 ? `<Picture ${endIndex + 1}>` : "the authored final state"}. No source video is supplied.`;
  } else if (mode === "keyframe") {
    const start = startIndex >= 0 ? `<Picture ${startIndex + 1}>` : "the authored before-action state";
    const end = endIndex >= 0 ? `<Picture ${endIndex + 1}>` : "the authored completed state";
    modeDirective = `At 0.00 seconds begin from ${start}; execute one causal action chain and reach ${end} at ${timestamp(duration)} seconds.`;
  }

  // A single executable camera timeline owns dialogue, actions and sound.
  // Merge visual boundaries that would cut a complete spoken window in half.
  for (let index = 1; index < visualSegments.length;) {
    const boundary = Number(visualSegments[index].start);
    if (resolvedDialogueWindows.some(window => boundary > Number(window.start) + 0.001 && boundary < Number(window.end) - 0.001)) {
      const left = visualSegments[index - 1], right = visualSegments[index];
      left.end = right.end;
      left.action = unique([left.action, right.action]).join("; then ");
      left.after = right.after;
      left.sound = unique([left.sound, right.sound]).join("; ");
      visualSegments.splice(index, 1);
    } else index += 1;
  }
  const visualDescription = visualSegments.map((segment, index) => {
    const prefix = index === 0
      ? "[Shot 1]"
      : `[Shot ${index + 1}] At ${officialClockTimestamp(segment.start)}, the camera cuts directly.`;
    const action = englishOnly(clean(segment.action).replace(/[.!?]+$/g, ""), "Complete the authored action", 180);
    const boundFraming=bindProviderCueSubjects(segment.framing,bindings,references);
    const framing = clean(segment.camera).includes(clean(boundFraming)) || (index>0&&clean(segment.framing)===clean(visualSegments[index-1].framing)) ? '' : englishOnly(boundFraming, "", 200);
    const repeatedCamera=index>0&&clean(segment.camera)===clean(visualSegments[index-1].camera);
    const camera = repeatedCamera ? 'Keep the established camera treatment and axis, framing the current named active speaker; do not replay completed cutaways' : englishOnly(clean(segment.camera).replace(/[.!?]+$/g, ""), "Hold a readable story-focused shot on the established axis", 105);
    const before = index>0&&clean(segment.before)===clean(visualSegments[index-1].after)?'the preceding shot\'s exact final physical state':englishOnly(clean(segment.before).replace(/[.!?]+$/g, ""), "Continue the exact authored prior state", 130);
    const after = clean(segment.after)===clean(segment.before)?'the same established physical state, retaining the performed emotional change':englishOnly(clean(segment.after).replace(/[.!?]+$/g, ""), "Reach the authored visible end state", 180);
    const blocking = index>0&&clean(segment.blocking)===clean(visualSegments[index-1].blocking)?'Maintain the preceding established positions, facing and axis':englishOnly(clean(segment.blocking).replace(/[.!?]+$/g, ""), "", 140);
    const backgroundAction = index>0&&clean(segment.backgroundAction)===clean(visualSegments[index-1].backgroundAction)?'Continue the established silent background reaction without replay':englishOnly(clean(segment.backgroundAction).replace(/[.!?]+$/g, ""), "", 95);
    const dialogue = dialogueDescriptions.filter((_line, turnIndex) => Number(resolvedDialogueWindows[turnIndex]?.start) >= Number(segment.start) - 0.001 && Number(resolvedDialogueWindows[turnIndex]?.start) < Number(segment.end) - 0.001).join(" ");
    return `${prefix} From ${timestamp(segment.start)} to ${timestamp(segment.end)} seconds, ${dialogue} ${action}.${framing ? ` Framing: ${framing}.` : ""} Camera: ${camera}.${blocking ? ` Blocking and screen direction: ${blocking}.` : ""}${backgroundAction ? ` Background and listener action: ${backgroundAction}.` : ""} Begin with ${before}; finish with ${after}.`;
  });
  const silenceDescription = !turns.length
    ? `From 0.0 to ${timestamp(duration)} seconds, no one speaks; every visible mouth remains at rest while the physical action and reaction complete.`
    : lastDialogueEnd < duration - 0.05
      ? `From ${timestamp(lastDialogueEnd)} to ${timestamp(duration)} seconds, no one speaks; every visible mouth remains at rest while the remaining authored physical action and visible reaction continue into the exact final state. Never freeze, wait idly, or add another line.`
      : "";
  const cutDescription = speakerCutTimes.length
    ? `At ${speakerCutTimes.map(value => `${timestamp(value)} seconds`).join(", ")}, switch camera ownership and speaking-mouth ownership together with a direct hard cut to the next authored on-screen speaker's established face. An off-screen voice never acquires a visible mouth or forces a camera cut.`
    : "";
  const authoredSound = sanitizeUnauthoredVocalSound(bindProviderCueSubjects(metadataCue(spec?.overallSoundscapeEn, "", 260), bindings, references)
    .replace(/\b(?:bgm|underscore|score|soundtrack|non[- ]?diegetic\s+music|background\s+music)\b[^.!]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim());
  const overallSoundscape = [
    turns.length
      ? (references.audios.length
        ? "Use only the assigned speaker timbres for the exact once-only Chinese lines; all other people remain silent."
        : "Generate a character-consistent native voice for each exact once-only Chinese dialogue line from the bound character identity and written text; all other people remain silent.")
      : "There is no speech in this clip.",
    [authoredSound, soundDetails, bindProviderCueSubjects(sourceSoundTimeline(shot, visualSegments), bindings, references)].filter(Boolean).join("; ") || "Maintain continuous natural room tone and only action sounds visibly caused inside the scene.",
    "At any instant, at most one authored speaker is audible; all others stay silent, with no overlap, improvised word, background vocal sound or decorative noise.",
    "Keep room tone and visible-source action sound continuous through the final frame."
  ].join(" ");
  const summaryParts = [
    mode.replaceAll("_", " "),
    list(references?.images).length ? "image reference" : "",
    videos.length ? "video reference" : "",
    list(references?.audios).length ? "audio reference" : ""
  ].filter(Boolean);
  const summary = metadataCue(
    spec?.summaryEn || shot?.summaryEn || shot?.visualBeatEn || shot?.actionEn,
    "Execute one continuous authored dramatic cause, essential action, and visible consequence without inventing another event.",
    250
  );
  const detailedDescription = [
    HAILUO_FINAL_OUTPUT_LOCK,
    turns.length ? "From 0.00 to 0.30 seconds, all visible mouths remain fully closed and silent; establish the authored blocking with room tone only. After 0.30 seconds, begin the first syllable once and cleanly, with no lip smack, tongue click, throat clear, inhale vocalization, false start, filler syllable or cut-off sound." : "",
    dialogueFirstPriority && turns.length
      ? "Resolve every instruction in this order: exact words and speaker, vocal tone, visible emotion, causal action, then blocking and facing."
      : "",
    modeDirective,
    framingContract,
    ensembleContract,
    ...visualDescription,
    silenceDescription,
    cutDescription,
    ...treatmentOwnershipContracts.slice(0, 1).map(({ actor, recipient }) => `The treatment recipient is ${recipient}; ${actor} performs the action only on ${recipient}, and every named hair, temple, root, scalp, face, garment part, or body part in this action belongs to ${recipient}.`),
    "Every person, product and prop remains one unique physical instance; preserve identity, age, current wardrobe, location geometry, light, screen direction and the 180-degree eyeline axis. Holder and physical state follow the exact authored changes, never freeze a prop in its reference pose.",
    bindProviderCueSubjects(physicalContinuityDirections(project, shot), bindings, references),
    "A principal character may enter only through an authored doorway or frame edge in a visible continuous entrance beat before speaking; never materialize, teleport, swap screen sides, or appear between cuts without an entrance action and state handoff.",
    (shot.productMention || list(references?.imageRoles).some(role => clean(role?.type) === "product")) ? "During product dialogue, the active named presenter physically holds the single exact referenced product in the story space. Any detail cut begins on that same hand-held package and returns to the same holder; never replace the performance with a detached full-frame product still, floating packshot, unrelated generated package, or separate advertisement image." : "",
    "Reference images establish identity, appearance, space, product and prop continuity only; never photograph or reproduce an asset board, contact sheet, split view, label, interface or reference file inside the story frame.",
    require('./clean-frame-contract').LOCK,
    "Only the authored Chinese dialogue enclosed by the dialogue tags above is spoken; every other sentence is silent direction.",
    "Every dialogue line has one clean onset and one final syllable only: no mouth click, tongue click, lip smack, throat clear, inhale vocalization, false start, repeated line, restart, echo or partial duplicate.",
    qualityRepair ? "Quality repair: correct the prior technical failure while preserving the authored dialogue, action order, reference bindings and final state." : ""
  ].filter(Boolean);
  if (["text_to_video", "image_to_video"].includes(providerApiMode)) {
    const alignment = providerApiMode === "image_to_video"
      ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${Math.max(1, visualSegments.length)}) aligns with the ${duration.toFixed(2)}-second mark of the target video.`
      : "";
    return compactGeneratedPromptBoilerplate([
      alignment,
      alignment ? "" : null,
      "integrated_multimodal_description:",
      ...detailedDescription,
      "",
      "overall_soundscape:",
      overallSoundscape,
      "",
      "non_diegetic_music:",
      "N/A"
    ].filter(line => line !== null).join("\n").trim());
  }
  return compactGeneratedPromptBoilerplate([
    "subject_definitions:",
    ...(bindings.definitions.length
      ? bindings.definitions.map(line => englishOnly(line, line, 300))
      : ["No unbound principal subject may be invented for this clip."]),
    "",
    "summary:",
    `[${officialReferenceTaskTypes(references)}] ${summary} Target length ${duration.toFixed(2)} seconds, ${aspect}, live-action.`,
    "",
    "retention_analysis:",
    ...(bindings.retention.length
      ? bindings.retention.map(line => englishOnly(line, line, 180))
      : ["Preserve the authored physical state, location continuity and screen direction throughout the clip."]),
    "",
    "detailed_description:",
    ...detailedDescription,
    "",
    "overall_soundscape:",
    overallSoundscape,
    "",
    "non_diegetic_music:",
    "N/A"
  ].join("\n").trim());
}

module.exports = {
  HAILUO_FINAL_OUTPUT_LOCK,
  HAILUO_LEGACY_FINAL_OUTPUT_LOCK,
  HAILUO_INTEGRATED_PROMPT_HEADER,
  HAILUO_INTEGRATED_OUTPUT_LOCK_ZH,
  buildApprovedHailuoPrompt,
  crossShotHandoffDirective,
  authoredEnsembleReaction,
  completeMasterActionCoverage,
  deterministicEnglishCue,
  dialogueAlignedVisualWindows,
  dialogueTimingPlan,
  timedVisualSegments,
  reconcileReflowedDialogueVisuals,
  sanitizeVisualPromptCue,
  authoredScreenSide,
  hasRecipientTreatmentAction,
  compactGeneratedPromptBoilerplate
};
