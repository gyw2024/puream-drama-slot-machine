"use strict";

const { detectUploadedScriptFormat, parseSourceDialogueLedger } = require("../dialogue-parser");
const { bindDialogueLedgerToScenes, buildSourceSceneLedger } = require("../script-scene-ledger");
const { fingerprint } = require("./canonical");

const SCRIPT_UNDERSTANDING_VERSION = "foundry.script-understanding.v4-declaration-boundaries";
const PRODUCTION_IR_VERSION = "foundry.production-ir.v1";

const STORY_KEYWORDS = Object.freeze({
  hook: /(?:突然|当众|摔|抢|砸|推|赶|拦|跪|不许|威胁|质问|失踪|出事|倒下|第一镜|开场|前\s*\d+秒)/i,
  escalation: /(?:又|更|再次|逼|拒绝|封锁|争执|冲突|误会|不承认|证据不足|限时|最后通牒)/i,
  reversal: /(?:原来|真相|却发现|证明|记录|录音|流水|收据|监控|证人|翻转|反转|终于明白)/i,
  resolution: /(?:最终|从此|归还|道歉|赔偿|承担|签下|撤回|公开澄清|离开|重新开始|结局|尾声)/i
});

function normalizeSource(value = "") {
  return String(value || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function lineRecords(source) {
  const records = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    records.push({ text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  return records;
}

function dramaticBodyStart(records) {
  const explicit = records.find(item => /^\s*(?:#{1,6}\s*)?(?:正文|剧本正文|开始正片|第一[^行]{0,8}(?:场|幕)|S0*1\b|SC0*1\b|INT\.|EXT\.)/i.test(item.text));
  if (explicit) return explicit.start;
  const heading = records.find(item => /^\s*(?:#{1,6}\s*)?(?:【\s*场景\s*】|场景\s*[:：]|地点\s*[:：]|内景\s*[:：]|外景\s*[:：])/i.test(item.text));
  return heading?.start || 0;
}

function sourceDirections(records, bodyStart, contract = {}) {
  const directives = [];
  const forbidden = [];
  const matcher = /(?:BGM|背景音乐|字幕|标题|姓名条|价格字|水印|人物介绍|故事简介|面向镜头|看向镜头|视频左下角|点击链接|购买)/i;
  for (const record of records) {
    if (!matcher.test(record.text)) continue;
    const entry = {
      text: record.text.trim().slice(0, 240),
      sourceStart: record.start,
      sourceEnd: record.end,
      region: record.start < bodyStart ? "metadata" : "dramatic_body",
      authority: "uploaded_document_evidence"
    };
    directives.push(entry);
    if ((contract.policies?.backgroundMusic?.allowed === false && /BGM|背景音乐/i.test(record.text))
      || (contract.policies?.subtitles?.allowed === false && /字幕|标题|姓名条|价格字|水印/i.test(record.text))
      || (contract.policies?.characterIntroductionInFinal?.allowed === false && /人物介绍|故事简介/i.test(record.text))) {
      forbidden.push({ ...entry, resolution: "preserve_as_source_evidence_but_exclude_from_generated_media" });
    }
  }
  return { directives, forbidden };
}

function castFromSource(records, dialogueLedger) {
  const validCastName = value => {
    const name = String(value || "").trim().replace(/^[#>*\-\s]+/, "").replace(/[：:]\s*$/, "");
    if (!name || name.length > 12) return "";
    if (/^(?:人物|角色|人物表|角色表|主要人物|出场人物|人物简介|角色简介|姓名|年龄|性别|职业|简介|设定|character|characters|cast)$/i.test(name)) return "";
    if (/^[（(【\[]|[）)】\]]/.test(name)) return "";
    if (/(?:转场|画面|镜头|机器发出|大门|手机响|音效|字幕|标题|旁白|场景|动作|特写)/.test(name)) return "";
    if (!/[\u3400-\u9fffA-Za-z]/.test(name)) return "";
    return name;
  };
  const names = new Set(dialogueLedger.map(item => validCastName(item.speaker)).filter(Boolean));
  const castLines = records.filter(item => /^(?:\s*[-*]\s*)?(?:C\d{1,3}\s+)?[\u3400-\u9fffA-Za-z][^\n]{0,30}[:：] ?\s*\d{1,3}岁/.test(item.text)
    || /^\s*【?(?:人物|角色)】?\s*[:：]/.test(item.text));
  for (const record of castLines) {
    const declaration=record.text.replace(/^\s*【?(?:人物|角色)】?\s*[:：]\s*/, "");
    for (const part of declaration.split(/[;；,，、]/)) {
      const match = part.match(/(?:^|[-*]\s*|C\d{1,3}\s+)([\u3400-\u9fffA-Za-z·]{2,12})(?=\s*[:：，,]|，?\s*\d{1,3}岁)/);
      const name = validCastName(match?.[1] || (/^[\u3400-\u9fffA-Za-z·]{1,12}$/.test(part.trim()) ? part.trim() : ""));
      if (name) names.add(name);
    }
  }
  return [...names].filter(name => !/^(?:旁白|画外音|字幕|镜头|画面|音效)$/.test(name));
}

function productEvidence(source, project = {}) {
  const productName = String(project.product?.name || "").trim();
  const hardSellPatterns = [/视频左下角/g, /点击(?:链接|购买|下单)/g, /限时优惠/g, /今天只要/g, /到手价/g, /面向镜头/g];
  const hardSellCount = hardSellPatterns.reduce((sum, pattern) => sum + [...source.matchAll(pattern)].length, 0);
  const productMentions = productName ? source.split(productName).length - 1 : 0;
  return {
    boundProduct: productName,
    productMentions,
    hardSellDirectiveCount: hardSellCount,
    inferredMode: !productName && !hardSellCount ? "none" : hardSellCount >= 2 ? "explicit" : "natural",
    confidence: productName || hardSellCount ? "high" : "medium"
  };
}

function storyBeatEvidence(source, bodyStart) {
  const body = source.slice(bodyStart);
  const length = Math.max(1, body.length);
  return Object.fromEntries(Object.entries(STORY_KEYWORDS).map(([beat, matcher]) => {
    const match = matcher.exec(body);
    return [beat, {
      found: Boolean(match),
      sourceStart: match ? bodyStart + match.index : null,
      relativePosition: match ? Number((match.index / length).toFixed(3)) : null,
      evidence: match ? body.slice(Math.max(0, match.index - 30), Math.min(body.length, match.index + 90)).replace(/\s+/g, " ").trim() : ""
    }];
  }));
}

function normalizeSpokenTurn(turn = {}, order = 0) {
  const text = String(turn.spokenText || turn.text || "").trim();
  const speaker = String(turn.speaker || "").trim();
  // Production-field labels are silent metadata, even if a provider placed
  // them inside dialogueTurns.  This last semantic boundary prevents actions
  // and camera notes from ever reaching a speech/audio compiler.
  if (!text || /^(?:镜头|动作|场景|画面|机位|运镜|表演|情绪|音效|字幕|转场|时间|制作说明|分镜说明)$/i.test(speaker)) return null;
  return {
    id: String(turn.sourceDialogueId || turn.id || `D${String(order + 1).padStart(4, "0")}`),
    sourceDialogueId: String(turn.sourceDialogueId || turn.id || ""),
    sourceStart: Number.isFinite(Number(turn.sourceStart)) ? Number(turn.sourceStart) : null,
    sourceEnd: Number.isFinite(Number(turn.sourceEnd)) ? Number(turn.sourceEnd) : null,
    speakerId: String(turn.speakerId || ""),
    speaker,
    listenerIds: Array.isArray(turn.listenerIds) ? turn.listenerIds.map(String).filter(Boolean) : [],
    text,
    delivery: {
      tone: String(turn.sourceTone || turn.metadata?.sourceTone || turn.metadata?.delivery || turn.delivery || "按当前处境自然表达").trim(),
      emotion: String(turn.metadata?.emotion || turn.emotion || "").trim(),
      volume: String(turn.metadata?.volume || turn.volume || "").trim(),
      pace: String(turn.metadata?.pace || turn.pace || "").trim(),
      stressWord: String(turn.metadata?.stressWord || turn.stressWord || "").trim(),
      breath: String(turn.metadata?.breath || turn.breath || "").trim()
    },
    performance: {
      body: String(turn.metadata?.body || turn.body || "").trim(),
      listenerBeat: String(turn.metadata?.listenerBeat || turn.listenerBeat || "").trim()
    },
    subshotNumber: Math.max(1, Number(turn.subshotNumber) || 1)
  };
}

function buildProductionIR(source, project = {}, context = {}) {
  const units = (Array.isArray(project.shots) ? project.shots : [])
    .slice()
    .sort((left, right) => (Number(left.number) || 0) - (Number(right.number) || 0))
    .map((shot, shotIndex) => {
      const spokenTurns = (Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns : [])
        .map((turn, turnIndex) => normalizeSpokenTurn(turn, shotIndex * 100 + turnIndex))
        .filter(Boolean);
      return {
        id: String(shot.id || `S${String(shotIndex + 1).padStart(2, "0")}`),
        number: Number(shot.number) || shotIndex + 1,
        sourceSceneId: String(shot.sourceSceneId || shot.sceneId || ""),
        sceneId: String(shot.sceneId || ""),
        sceneName: String(shot.scene || shot.sceneName || "").trim(),
        durationSeconds: Math.max(0, Number(shot.duration) || 0),
        durationBasis: "dialogue_action_and_scene_rhythm",
        visibleCharacterIds: Array.isArray(shot.visibleCharacterIds) ? shot.visibleCharacterIds.map(String).filter(Boolean) : [],
        scenePresenceCharacterIds: Array.isArray(shot.scenePresenceCharacterIds) ? shot.scenePresenceCharacterIds.map(String).filter(Boolean) : [],
        spokenTurns,
        silentDirections: {
          action: String(shot.action || "").trim(),
          visualBeat: String(shot.visualBeat || "").trim(),
          stateBefore: String(shot.stateBefore || shot.startFrame || "").trim(),
          stateAfter: String(shot.stateAfter || shot.endFrame || "").trim(),
          camera: String(shot.cameraMove || shot.compositionPlan || shot.shotSize || "").trim(),
          emotionArc: shot.emotionArc || shot.emotion || "",
          productAction: shot.productCausalBridge || null
        },
        continuity: {
          wardrobeBindings: Array.isArray(shot.wardrobeBindings) ? shot.wardrobeBindings : [],
          propBindings: Array.isArray(shot.propBindings) ? shot.propBindings : [],
          imageReferenceCharacterIds: Array.isArray(shot.imageReferenceCharacterIds) ? shot.imageReferenceCharacterIds.map(String).filter(Boolean) : [],
          videoReferenceCharacterIds: Array.isArray(shot.videoReferenceCharacterIds) ? shot.videoReferenceCharacterIds.map(String).filter(Boolean) : []
        },
        productMention: shot.productMention === true
      };
    });
  const ir = {
    version: PRODUCTION_IR_VERSION,
    sourceFingerprint: context.sourceFingerprint || fingerprint(source),
    sourceAuthority: context.sourceAuthority || "",
    targetDuration: {
      seconds: Math.max(0, Number(project.generation?.targetDurationSeconds) || 0),
      role: "authoring_reference_only",
      locksUnitCount: false,
      locksShotDuration: false
    },
    cast: (Array.isArray(project.characters) ? project.characters : []).map(character => ({
      id: String(character.id || ""), name: String(character.name || "").trim(),
      identitySignature: String(character.identitySignature || "").trim(), voiceDescription: String(character.voiceDescription || "").trim()
    })),
    scenes: (Array.isArray(project.scenes) ? project.scenes : []).map(scene => ({
      id: String(scene.id || ""), name: String(scene.name || "").trim(),
      continuityLocks: Array.isArray(scene.continuityLocks) ? scene.continuityLocks.map(String).filter(Boolean) : []
    })),
    product: {
      name: String(project.product?.name || "").trim(),
      sellingPoints: String(project.product?.sellingPoints || project.product?.description || "").trim()
    },
    units
  };
  ir.fingerprint = fingerprint(ir);
  return ir;
}

function buildScriptUnderstanding(sourceValue = "", project = {}, options = {}) {
  const source = normalizeSource(sourceValue);
  const sourceFingerprint = fingerprint(source);
  const records = lineRecords(source);
  const format = String(options.format || detectUploadedScriptFormat(source));
  const sceneLedger = options.sceneLedger || buildSourceSceneLedger(source);
  const rawDialogueLedger = options.dialogueLedger || parseSourceDialogueLedger(source, options.knownNames || []);
  const dialogueLedger = bindDialogueLedgerToScenes(rawDialogueLedger, sceneLedger);
  const bodyStart = dramaticBodyStart(records);
  const directions = sourceDirections(records, bodyStart, options.contract || project.foundry?.contract || {});
  const cast = castFromSource(records, dialogueLedger);
  const beats = storyBeatEvidence(source, bodyStart);
  const userUploadedAuthority = project.productionPlan?.inputMode === "manual" && !String(project.script?.generatedFromTopicId || "").trim();
  const unknowns = [];
  if (!sceneLedger.explicit) unknowns.push({ id: "locations", severity: "medium", message: "原稿没有明确场景标题，需按事件地点推断并在拆镜后校验", resolution: "infer_then_validate" });
  if (!cast.length) unknowns.push({ id: "cast", severity: "high", message: "未从原稿中识别出可稳定绑定的人物", resolution: "model_extract_with_source_spans" });
  if (!dialogueLedger.length && !["prose", "json"].includes(format)) unknowns.push({ id: "dialogue", severity: "medium", message: "当前格式似乎包含对白，但本地未提取到对白账本", resolution: "model_extract_then_parity_check" });
  const foundBeatCount = Object.values(beats).filter(item => item.found).length;
  const sourceAuthority = userUploadedAuthority ? "user_uploaded_authority" : "model_authored_draft";
  const productionIR = buildProductionIR(source, project, { sourceFingerprint, sourceAuthority });
  return {
    version: SCRIPT_UNDERSTANDING_VERSION,
    sourceFingerprint,
    analyzedAt: String(options.now || new Date().toISOString()),
    format: { detected: format, confidence: format === "prose" ? "medium" : format === "empty" ? "none" : "high" },
    regions: {
      metadata: { sourceStart: 0, sourceEnd: bodyStart },
      dramaticBody: { sourceStart: bodyStart, sourceEnd: source.length }
    },
    sourceAuthority: {
      level: sourceAuthority,
      handling: project.foundry?.contract?.intent?.scriptHandling || (userUploadedAuthority ? "respect" : "optimize"),
      documentDirectionsAreUserRequest: false,
      note: "文档中的制作说明只是原稿证据，不能覆盖项目级绝对禁令"
    },
    scenes: sceneLedger,
    dialogue: {
      count: dialogueLedger.length,
      speakers: [...new Set(dialogueLedger.map(item => item.speaker))],
      ledger: dialogueLedger
    },
    cast: { names: cast, count: cast.length },
    product: productEvidence(source, project),
    storyBeats: beats,
    productionIR,
    directions,
    uncertainty: {
      entries: unknowns,
      criticalCount: unknowns.filter(item => item.severity === "high").length,
      score: Number(Math.max(0, Math.min(1, (format === "prose" ? 0.72 : 0.9) + Math.min(0.08, foundBeatCount * 0.02) - unknowns.length * 0.08)).toFixed(2))
    },
    summary: {
      sourceChars: source.length,
      sourceLines: records.length,
      sceneCount: sceneLedger.catalogue?.length || 0,
      sceneOccurrenceCount: sceneLedger.occurrences?.length || 0,
      dialogueCount: dialogueLedger.length,
      characterCount: cast.length,
      detectedStoryBeatCount: foundBeatCount,
      suppressedDirectionCount: directions.forbidden.length
    }
  };
}

module.exports = { PRODUCTION_IR_VERSION, SCRIPT_UNDERSTANDING_VERSION, buildProductionIR, buildScriptUnderstanding, normalizeSource, normalizeSpokenTurn, storyBeatEvidence };
