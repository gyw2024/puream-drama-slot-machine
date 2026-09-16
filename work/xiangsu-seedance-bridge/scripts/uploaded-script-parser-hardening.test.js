"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isProductionFieldLabel, parseSourceDialogueLedger, parseSpeakerLabel, sortSourceDialogueLedger } = require("../app/dialogue-parser");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");
const {
  localUploadedAnalysisChunk,
  parseStructuredProductionScript,
  productionDialogueLedgerFromScript,
  renderProductionScript,
  bindSourceDialogueLedgerToAnalysis,
  normalizeAnalysis,
  applyUploadedProductBindings,
  conformImportedAnalysisToDurationContract,
  uploadedFormatAdaptationValidation,
  validateScriptAnalysisChunkResult
} = require("../app/workbench-workflow");

test("semicolon cast records do not turn professions into extra people",()=>{
  const raw="人物：陈远，快递员；赵淑芳，独居老人；梁志刚，社区快递驿站站长。\n陈远：包裹送到了。\n赵淑芳：谢谢你。\n梁志刚：我们来帮忙。";
  const parsed=localUploadedAnalysisChunk({text:raw,sourceDialogueLedger:parseSourceDialogueLedger(raw)},{script:{raw}});
  assert.deepEqual(parsed.characters.map(c=>c.name),["陈远","赵淑芳","梁志刚"]);
  const list="人物：快递员，老人\n快递员：到了。\n老人：谢谢。";
  const unnamed=localUploadedAnalysisChunk({text:list,sourceDialogueLedger:parseSourceDialogueLedger(list)},{script:{raw:list}});
  assert.deepEqual(unnamed.characters.map(c=>c.name),["快递员","老人"]);
});

test("production field labels are not speakers", () => {
  assert.equal(parseSpeakerLabel("本单元叙事任务"), null);
  assert.equal(parseSpeakerLabel("转场"), null);
  assert.equal(parseSpeakerLabel("首帧"), null);
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜厨房",
    "- 本单元叙事任务：母亲拿出缴费单",
    "- 转场：客厅",
    "苏妈（发颤）：缴费单在这儿。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => item.speaker), ["苏妈"]);
  assert.deepEqual(ledger.map(item => item.text), ["缴费单在这儿。"]);
});

test("compound production fields never become dialogue speakers", () => {
  const raw = [
    "分镜名称：雨夜对质",
    "镜头时长：10秒",
    "画面与动作：母亲推门进来",
    "声音与音效：门轴轻响",
    "景别与运镜：中景缓慢推进",
    "参考视频：历史参考片段",
    "对白：母亲（压低声音）：你先听我说完。"
  ].join("\n");
  assert.equal(isProductionFieldLabel("分镜名称"), true);
  assert.equal(isProductionFieldLabel("镜头时长"), true);
  assert.equal(isProductionFieldLabel("画面与动作"), true);
  assert.equal(parseSpeakerLabel("分镜名称"), null);
  assert.deepEqual(parseSourceDialogueLedger(raw).map(item => `${item.id}:${item.speaker}:${item.text}`), [
    "D001:母亲:你先听我说完。"
  ]);
});

test("provider field-name variants are rejected compositionally", () => {
  const fields = [
    "分镜视频提示词", "分镜合图提示词", "镜头运动", "镜头语言", "片段时长",
    "时间范围", "动作描述", "画面描述", "对白内容", "台词内容", "旁白内容",
    "人物服装", "产品植入", "参考图片", "参考音频", "首尾帧设置"
  ];
  const raw = [...fields.map((field, index) => `${field}：制作字段${index + 1}`), "周岚（克制）：真实对白完整保留。"].join("\n");
  assert.ok(fields.every(isProductionFieldLabel));
  assert.deepEqual(parseSourceDialogueLedger(raw).map(item => `${item.speaker}:${item.text}`), [
    "周岚:真实对白完整保留。"
  ]);
});

test("inline production directions preserve the embedded authored dialogue", () => {
  const ledger = parseSourceDialogueLedger("画面与动作：母亲推门进来；对白：母亲（急促）：快把灯关掉！");
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), ["母亲:快把灯关掉！"]);
});

test("legacy polluted ledger is sanitized locally before dialogue binding", () => {
  const polluted = [
    { id: "D001", speaker: "分镜名称", speakerRaw: "分镜名称", text: "雨夜对质" },
    { id: "D002", speaker: "镜头时长", speakerRaw: "镜头时长", text: "10秒" },
    { id: "D003", speaker: "画面与动作", speakerRaw: "画面与动作", text: "母亲推门进来" },
    { id: "D004", speaker: "母亲", speakerRaw: "母亲", tone: "压低声音", text: "你先听我说完。" }
  ];
  const bound = bindSourceDialogueLedgerToAnalysis({
    characters: [{ id: "C01", name: "母亲" }],
    shots: [{ id: "S01", duration: 10, sourceDialogueBindings: [{ sourceDialogueId: "D004", subshotNumber: 1 }], subshots: [{ number: 1, start: 0, end: 10 }] }]
  }, polluted);
  assert.deepEqual(bound.sourceDialogueLedger.map(item => item.id), ["D004"]);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(item => item.text), ["你先听我说完。"]);
});

test("dialogue before the first S01 heading is kept", () => {
  const ledger = parseSourceDialogueLedger([
    "【场景】厨房",
    "林娜（压低声音）：你来了。",
    "### S01｜近景",
    "秦深（坐下）：把单子给我。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => item.text), ["你来了。", "把单子给我。"]);
});

test("slash-separated speakers on one line are split", () => {
  const ledger = parseSourceDialogueLedger("苏远（怒）：缴费单呢。 / 苏妈（颤）：我收着。");
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), ["苏远:缴费单呢。", "苏妈:我收着。"]);
});

test("scene lists and time suffixes do not become dirty or fake places", () => {
  const listed = buildSourceSceneLedger("【场景】老小区客厅、老小区楼道、银行大厅");
  assert.deepEqual(listed.catalogue.map(item => item.name), ["老小区客厅", "老小区楼道", "银行大厅"]);
  const timed = buildSourceSceneLedger("### SC01 苏妈厨房｜傍晚\n苏妈：先吃饭。");
  assert.ok(timed.catalogue.every(item => !/傍晚|白天|夜晚/.test(item.name)));
  assert.ok(timed.catalogue.some(item => item.name.includes("苏妈厨房")));
  const dashTransition = buildSourceSceneLedger("【场景】厨房\n- 转场：客厅\n苏妈：过来。");
  assert.ok(dashTransition.catalogue.some(item => item.name === "客厅"));
});

test("26 timed blocks collapse to unique physical scene assets", () => {
  const raw = Array.from({ length: 26 }, (_, index) => {
    const start = index * 10;
    const location = index < 18
      ? (index === 1 ? "旧小区楼道（次日清晨）" : "旧小区楼道")
      : "银行大厅";
    return `${start}-${start + 10}秒\n场景：${location}\n周宁：第${index + 1}段对白完整保留。`;
  }).join("\n");
  const ledger = buildSourceSceneLedger(raw);
  assert.deepEqual(ledger.catalogue.map(item => item.name), ["旧小区楼道", "银行大厅"]);
  assert.ok(ledger.catalogue.every(item => !/^\d+\s*[-~—至]\s*\d+\s*秒$/.test(item.name)));
});

test("Agent analysis rejects time ranges and shot headings as scene assets", () => {
  const base = {
    story: { premise: "客户上传剧本" },
    characters: [{ id: "C01", name: "周宁" }],
    props: [],
    shots: [{ id: "S01", duration: 10 }]
  };
  const timed = validateScriptAnalysisChunkResult({ ...base, scenes: [{ name: "0-10秒" }] }, { unitCount: 1 });
  assert.ok(Array.isArray(timed));
  assert.ok(timed.some(item => item.includes("不是物理空间")));
  const shotHeading = validateScriptAnalysisChunkResult({ ...base, scenes: [{ name: "第18镜" }] }, { unitCount: 1 });
  assert.ok(Array.isArray(shotHeading));
  assert.ok(shotHeading.some(item => item.includes("不是物理空间")));
});

test("local fallback keeps multiple scenes and core props from bracket lists", () => {
  const raw = [
    "【场景】老小区客厅",
    "物品：@房产证 @手机 @茶杯",
    "【核心道具】房产证",
    "周宁（压着火）：妈，房产证呢？",
    "【场景】银行大厅",
    "周桂兰（发颤）：我没卖房子。"
  ].join("\n");
  const data = localUploadedAnalysisChunk({
    index: 0,
    text: raw,
    unitCount: 2,
    durations: [10, 10],
    sourceDialogueLedger: parseSourceDialogueLedger(raw),
    sourceSceneLedger: buildSourceSceneLedger(raw)
  });
  assert.ok(data.scenes.some(item => item.name.includes("老小区客厅")));
  assert.ok(data.scenes.some(item => item.name.includes("银行大厅")));
  assert.ok(data.props.some(item => item.name === "房产证"));
  assert.ok(!data.props.some(item => item.name === "手机" || item.name === "茶杯"));
});

test("a 对白 prefix preserves the first speaker and distinct repeated source occurrences", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜楼梯口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), [
    "周妈:饭还热着。",
    "陈晓:你别上来了。",
    "周妈:饭还热着。",
    "陈晓:你别上来了。"
  ]);
  assert.equal(ledger[0].sourceShotId, "S01");
  assert.equal(ledger[1].sourceShotId, "S01");
});

test("standard production dialogue keeps spoken text separate from pipe metadata", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜00:00–00:08｜8秒",
    "- 对白：C01：住手！有话冲我来！｜beat=attack；sourceTone=愤怒起声；delivery=高压、急促；body=推门；listenerBeat=C02回头"
  ].join("\n"));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].speaker, "C01");
  assert.equal(ledger[0].text, "住手！有话冲我来！");
  assert.doesNotMatch(ledger[0].text, /beat=|delivery=|[｜|]/i);
  assert.equal(ledger[0].tone, "愤怒起声");
  assert.equal(ledger[0].delivery, "高压、急促");
  assert.deepEqual(ledger[0].metadata, {
    beat: "attack",
    sourceTone: "愤怒起声",
    delivery: "高压、急促",
    body: "推门",
    listenerBeat: "C02回头"
  });
});

test("same-shot source dialogue stays in source order with strictly increasing ledger order", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜00:00–00:08",
    "母亲：先别走。",
    "儿子：我没走。",
    "母亲：那就听我说。"
  ].join("\n"), ["母亲", "儿子"]);
  assert.deepEqual(ledger.map(item => item.text), ["先别走。", "我没走。", "那就听我说。"]);
  assert.deepEqual(ledger.map(item => item.order), [1, 2, 3]);
  assert.deepEqual(ledger.map(item => item.sourceOrder), [1, 2, 3]);
  assert.ok(ledger.every(item => item.tone && !/natural breath, pace and stress/i.test(item.tone)));
});

test("source offsets override shuffled provider IDs without rewriting dialogue", () => {
  const shuffledLedger = [
    { id: "D003", order: 1, sourceOrder: 3, sourceStart: 90, speaker: "林夏", text: "第三句，标点必须保留！" },
    { id: "D001", order: 3, sourceOrder: 1, sourceStart: 10, speaker: "林夏", text: "第一句不能被改写。" },
    { id: "D002", order: 2, sourceOrder: 2, sourceStart: 50, speaker: "周峰", text: "第二句？也不能丢。" }
  ];
  const before = JSON.stringify(shuffledLedger);
  const bound = bindSourceDialogueLedgerToAnalysis({
    characters: [{ id: "C01", name: "林夏" }, { id: "C02", name: "周峰" }],
    shots: [{
      id: "S01",
      characterIds: ["C01", "C02"],
      sourceDialogueBindings: [
        { sourceDialogueId: "D003", subshotNumber: 1 },
        { sourceDialogueId: "D001", subshotNumber: 2 },
        { sourceDialogueId: "D002", subshotNumber: 3 }
      ],
      subshots: [
        { number: 1, start: 0, end: 3, sourceDialogueIds: ["D003"] },
        { number: 2, start: 3, end: 6, sourceDialogueIds: ["D001"] },
        { number: 3, start: 6, end: 10, sourceDialogueIds: ["D002"] }
      ]
    }]
  }, shuffledLedger);
  assert.deepEqual(bound.sourceDialogueLedger.map(item => item.id), ["D001", "D002", "D003"]);
  assert.deepEqual(bound.shots[0].sourceDialogueBindings.map(item => item.sourceDialogueId), ["D001", "D002", "D003"]);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(item => item.sourceDialogueId), ["D001", "D002", "D003"]);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(item => item.text), [
    "第一句不能被改写。", "第二句？也不能丢。", "第三句，标点必须保留！"
  ]);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(item => item.speaker), ["林夏", "周峰", "林夏"]);
  assert.deepEqual(bound.shots[0].dialogueTurns.map(item => item.speakerId), ["C01", "C02", "C01"]);
  assert.deepEqual(bound.sourceDialogueLedger.map(item => item.speaker), ["林夏", "周峰", "林夏"]);
  assert.deepEqual(bound.sourceDialogueLedger.map(item => item.speakerId), ["C01", "C02", "C01"]);
  assert.deepEqual(bound.shots[0].subshots.flatMap(item => item.dialogueTurns).map(item => item.sourceDialogueId), ["D001", "D002", "D003"]);
  assert.equal(JSON.stringify(shuffledLedger), before, "sorting must not mutate the immutable source records");
});

test("source-order fallback is stable and upload JSON standardization restores chronology", () => {
  const samePosition = sortSourceDialogueLedger([
    { id: "D003", sourceOrder: 3, text: "三" },
    { id: "D001", sourceOrder: 1, text: "一" },
    { id: "D002-A", sourceOrder: 2, text: "二甲" },
    { id: "D002-B", sourceOrder: 2, text: "二乙" }
  ]);
  assert.deepEqual(samePosition.map(item => item.id), ["D001", "D002-A", "D002-B", "D003"]);

  const standardized = productionDialogueLedgerFromScript(JSON.stringify({
    characters: [{ id: "C01", name: "林夏" }],
    scenes: [{ id: "SC01", name: "走廊" }],
    shots: [{ id: "S01" }],
    sourceDialogueLedger: [
      { id: "D003", sourceOrder: 3, sourceStart: 80, speaker: "林夏", text: "最后一句。" },
      { id: "D001", sourceOrder: 1, sourceStart: 8, speaker: "林夏", text: "开头一句。" },
      { id: "D002", sourceOrder: 2, sourceStart: 40, speaker: "林夏", text: "中间一句。" }
    ]
  }));
  assert.deepEqual(standardized.map(item => item.text), ["开头一句。", "中间一句。", "最后一句。"]);
  assert.deepEqual(standardized.map(item => item.id), ["D001", "D002", "D003"]);
  assert.deepEqual(standardized.map(item => item.sourceOrder), [1, 2, 3]);
});

test("rendered production script round-trips dialogue ledger and dialogue turns", () => {
  const turnText = ["住手！有话冲我来！", "先把人放开，这次别再回避。"];
  const normalized = {
    characters: [
      { name: "林夏", description: "护工，短发", identitySignature: "短发、蓝色护工服", voiceDescription: "清亮女声", signatureLine: turnText[0] },
      { name: "周峰", description: "中年男子", identitySignature: "黑夹克、方脸", voiceDescription: "低沉男声", signatureLine: turnText[1] }
    ],
    scenes: [{ name: "旧楼走廊", time: "日间", description: "狭窄旧楼走廊", atmosphere: "楼道底噪" }],
    shotPlan: [{ id: "S01" }, { id: "S02" }],
    shots: [
      {
        duration: 8, sceneName: "旧楼走廊", characterNames: ["林夏", "周峰"], action: "林夏推门挡在周峰面前",
        mainlineStage: "hook", mainlineBeat: "林夏制止冲突", kindnessCost: "承担报复风险", reversalSetup: "周峰手里的文件",
        stateBefore: "门外争执", stateAfter: "林夏挡住周峰", causalLink: "听见冲突后推门", visualBeat: "林夏推门挡人",
        compositionPlan: "双人中近景", audioPlan: "楼道环境底噪与门响", emotion: "愤怒到克制", startFrame: "门内争执", endFrame: "林夏站稳",
        shotSize: "中近景", cameraMove: "推近", soundDesign: "楼道环境底噪；门响", productMention: false,
        dialogue: `C01：${turnText[0]}｜beat=attack；delivery=愤怒起声→高压峰值；body=推门挡人；listenerBeat=周峰回头`,
        subshots: [{ start: 0, end: 8, framing: "中近景", camera: "推近", action: "林夏推门挡人", dialogue: `C01：${turnText[0]}｜beat=attack；delivery=愤怒起声→高压峰值；body=推门挡人；listenerBeat=周峰回头`, sound: "门响", transition: "硬切" }]
      },
      {
        duration: 8, sceneName: "旧楼走廊", characterNames: ["林夏", "周峰"], action: "周峰松手后退",
        mainlineStage: "pressure", mainlineBeat: "林夏要求放人", kindnessCost: "无", reversalSetup: "文件露出一角",
        stateBefore: "林夏挡人", stateAfter: "周峰松手", causalLink: "林夏继续施压", visualBeat: "周峰松手后退",
        compositionPlan: "反打近景", audioPlan: "楼道环境底噪与衣料声", emotion: "克制施压", startFrame: "双方对峙", endFrame: "周峰后退",
        shotSize: "近景", cameraMove: "硬切反打", soundDesign: "楼道环境底噪；衣料声", productMention: false,
        dialogue: `C01：${turnText[1]}｜beat=decision；delivery=压低声音、逐字施压；body=抬手示意；listenerBeat=周峰松手`,
        subshots: [{ start: 0, end: 8, framing: "近景", camera: "硬切反打", action: "林夏盯住周峰", dialogue: `C01：${turnText[1]}｜beat=decision；delivery=压低声音、逐字施压；body=抬手示意；listenerBeat=周峰松手`, sound: "衣料声", transition: "硬切" }]
      }
    ]
  };
  const blueprint = {
    title: "走廊里的证词", genre: "现实短剧", coreTheme: "制止伤害", mainReversalMechanism: "文件证据", logline: "护工制止冲突并逼出真相。",
    characters: [{ role: "护工" }, { role: "施压者" }], scenes: [{ time: "日间" }], props: [], shotPlan: normalized.shotPlan,
    story: { synopsis: "林夏在走廊制止周峰。", hook: "推门制止", mainReversal: "文件露出", payoff: ["周峰松手"], ending: "冲突暂止" }
  };
  const rendered = renderProductionScript(blueprint, normalized, {
    product: { name: "暖心阅读灯", sellingPoints: "柔和照明" },
    generation: { targetDurationSeconds: 16, shotDuration: 8, engine: "hailuo-h3" }
  }, { title: blueprint.title, logline: blueprint.logline, reversal: "文件证据", emotionalPayoff: "冲突暂止" });
  const parsed = parseStructuredProductionScript(rendered);
  assert.ok(parsed);
  assert.deepEqual(parsed.sourceDialogueLedger.map(item => item.text), turnText);
  assert.ok(parsed.sourceDialogueLedger.every(item => !/[｜|]|beat=|delivery=/i.test(item.text)));
  assert.deepEqual(parsed.shots.map(shot => shot.dialogueTurns.map(turn => turn.text)), [[turnText[0]], [turnText[1]]]);
  assert.equal(parsed.shots[0].dialogueTurns[0].speakerId, "C01");
  assert.equal(parsed.shots[0].dialogueTurns[0].intent, "attack");
  assert.equal(parsed.shots[0].dialogueTurns[0].delivery, "愤怒起声→高压峰值");
  assert.equal(parsed.shots[0].dialogueTurns[0].body, "推门挡人");
  assert.equal(parsed.shots[1].dialogueTurns[0].subshotNumber, 1);
});

test("subshot cue lines do not mint extra dialogue with sound suffixes", () => {
  const ledger = parseSourceDialogueLedger([
    "### S01｜10秒｜楼梯口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "- subshot 1｜0.0-3.0秒｜近景：周妈扶栏杆；对白：周妈：饭还热着。；声音：楼梯回声"
  ].join("\n"));
  assert.deepEqual(ledger.map(item => `${item.speaker}:${item.text}`), [
    "周妈:饭还热着。",
    "陈晓:你别上来了。"
  ]);
});

test("structured production script still parses official C/SC/S headings", () => {
  const raw = [
    "### C01 林夏",
    "- 28岁职场女性",
    "### SC01 会议室",
    "- 白天会议室",
    "### S01｜10秒｜会议室",
    "- 人物：C01",
    "- 场景：SC01",
    "- 动作：林夏换上黑色西装把录音笔立在桌上",
    "- 对白：林夏（冷静）：你听完再拦。",
    "林夏（冷静）：你听完再拦。",
    "### S02｜10秒｜会议室",
    "- 人物：C01",
    "- 场景：SC01",
    "- 动作：她按下录音笔播放封口费",
    "- 对白：林夏（肯定）：车库里，亲口。",
    "林夏（肯定）：车库里，亲口。"
  ].join("\n");
  const structured = parseStructuredProductionScript(raw);
  assert.ok(structured);
  assert.equal(structured.characters[0].name, "林夏");
  assert.equal(structured.shots.length, 2);
});

test("explicit 商品不出现 and authored 人物 survive dialogue rebinding", () => {
  const raw = [
    "### C01 周妈",
    "### C02 陈晓",
    "### SC01 楼梯口",
    "### SC02 客厅",
    "### S01｜10秒｜楼梯口",
    "- 人物：C01 C02",
    "- 场景：SC01 楼梯口",
    "- 动作：周妈被拦在门口",
    "- 对白：周妈（气喘）：饭还热着。",
    "陈晓（挡门）：你别上来了。",
    "- 商品：不出现",
    "### S02｜10秒｜客厅",
    "- 人物：C01 C02",
    "- 场景：SC02 客厅",
    "- 动作：周建把硅胶护膝戴上母亲右膝",
    "- 对白：周妈（看着）：这是护膝。",
    "- 商品：出现：硅胶护膝"
  ].join("\n");
  const structured = parseStructuredProductionScript(raw);
  const ledger = parseSourceDialogueLedger(raw, ["周妈", "陈晓"]);
  const bound = bindSourceDialogueLedgerToAnalysis({
    ...structured,
    sourceDialogueLedger: ledger
  }, ledger);
  const project = {
    product: { name: "硅胶护膝", description: "保护膝盖半月板损伤", sellingPoints: "保护膝盖半月板损伤" },
    generation: { targetDurationSeconds: 20, shotDuration: 10, engine: "hailuo-h3" },
    productionPlan: { inputMode: "manual", commerceShotCount: 1 }
  };
  const normalized = conformImportedAnalysisToDurationContract(bound, project, { adaptiveTargetSeconds: 20 });
  assert.deepEqual(normalized.shots[0].characterNames, ["周妈", "陈晓"]);
  assert.deepEqual(normalized.shots[0].dialogueTurns.map(item => item.text), ["饭还热着。", "你别上来了。"]);
  assert.equal(normalized.shots[0].productMention, false);
  assert.equal(normalized.shots[1].productMention, true);
  assert.ok((normalized.shots[1].productBinding?.matchedTokens || []).includes("护膝"));
});

test("customer Markdown screenplay keeps every scene occurrence and only real bold dialogue cues", () => {
  const raw = `# 婚礼前后的母亲尊严
- **目标受众**：中老年用户
- **建议时长**：约5分钟

## 人物
**顾晚晴**：女儿。
**赵桂芬**：母亲。
**马秀兰**：准婆婆。
**小周**：店员，只执行动作。

## 完整剧本
### 第一场 婚纱店试装区·下午
**画面**：马秀兰把窄鞋推到赵桂芬脚边。
**马秀兰**（皱眉）：亲家母，你就穿这双鞋上台？
**赵桂芬**（把脚往后藏）：我穿软鞋走路稳当。

### 第二场 婚纱店后厅·连续
**顾晚晴**（扶住母亲）：妈，我们先进去。

### 第三场 顾家小客厅·傍晚
**顾晚晴**：这件事我会处理。

### 第四场 顾家客厅·第二天上午（产品段）
**剧情作用**：同一物理客厅，推进产品使用。
**顾晚晴面向镜头**：先尊重老人的选择。

### 第五场 顾家楼道·三天后
**马秀兰**：是我做错了。

### 第六场 顾家阳台·夜晚
**结尾画面**：母女握手，阳台灯亮起。`;
  const scenes = buildSourceSceneLedger(raw);
  assert.deepEqual(scenes.catalogue.map(item => item.name), ["婚纱店试装区", "婚纱店后厅", "顾家小客厅", "顾家楼道", "顾家阳台"]);
  assert.deepEqual(scenes.catalogue[2].aliases, ["顾家客厅"]);
  assert.equal(scenes.occurrences.length, 6);
  const dialogue = parseSourceDialogueLedger(raw);
  assert.deepEqual(dialogue.map(item => item.speaker), ["马秀兰", "赵桂芬", "顾晚晴", "顾晚晴", "顾晚晴", "马秀兰"]);
  assert.equal(dialogue.some(item => /目标受众|建议时长|剧情作用|结尾画面|画面/.test(item.speaker)), false);
  assert.equal(dialogue[4].text, "先尊重老人的选择。");
  const local = localUploadedAnalysisChunk({ index: 0, text: raw, sourceDialogueLedger: dialogue, sourceSceneLedger: scenes }, { script: { raw }, characters: [] });
  assert.deepEqual(local.characters.map(item => item.name), ["顾晚晴", "赵桂芬", "马秀兰", "小周"]);
});

test("AI-first standard format is accepted only when scenes, occurrence order and dialogue all survive", () => {
  const raw = `### 第一场 客厅·上午
**甲**（克制）：这句话不能改。
### 第二场 楼道·连续
**乙**（急促）：我马上回来。`;
  const sourceScenes = buildSourceSceneLedger(raw);
  const sourceDialogue = productionDialogueLedgerFromScript(raw, null, sourceScenes);
  const complete = `### S01｜场景：客厅
【动作】甲站在桌边。
【对白】甲（克制）：这句话不能改。
【声音】室内底噪。
【承接】甲看向门口。
### S02｜场景：楼道
【动作】乙冲出门。
【对白】乙（急促）：我马上回来。
【声音】脚步声。
【承接】乙下楼。`;
  const accepted = uploadedFormatAdaptationValidation(complete, sourceDialogue, sourceScenes);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.actualDialogueCount, 2);
  assert.equal(accepted.actualSceneOccurrenceCount, 2);
  const incomplete = uploadedFormatAdaptationValidation(complete.replace(/### S02[\s\S]*$/u, ""), sourceDialogue, sourceScenes);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.dialogueParity, false);
  assert.equal(incomplete.sceneParity, false);
});

test("AI-first standard format automatically repairs a dropped authored action instead of losing the story", () => {
  const raw = [
    "场景：客厅",
    "【动作】母亲把缴费单压在桌面，女儿看见落款后愣住。",
    "母亲（克制）：这笔钱不是你欠的。"
  ].join("\n");
  const sourceScenes = buildSourceSceneLedger(raw);
  const sourceDialogue = productionDialogueLedgerFromScript(raw, null, sourceScenes);
  const incomplete = [
    "### S01｜场景：客厅",
    "【对白】母亲（克制）：这笔钱不是你欠的。",
    "【承接】女儿抬头。"
  ].join("\n");
  const rejected = uploadedFormatAdaptationValidation(incomplete, sourceDialogue, sourceScenes, raw);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.dialogueParity, true);
  assert.equal(rejected.sceneParity, true);
  assert.equal(rejected.narrativeParity, false);
  assert.deepEqual(rejected.missingNarrative.map(item => item.id), ["E001"]);
  const complete = incomplete.replace("【对白】", "【动作】母亲把缴费单压在桌面，女儿看见落款后愣住。\n【对白】");
  const accepted = uploadedFormatAdaptationValidation(complete, sourceDialogue, sourceScenes, raw);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.narrativeParity, true);
});
