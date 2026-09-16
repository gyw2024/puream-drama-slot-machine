"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkbenchStore } = require("../app/workbench-store");
const { buildCameraTakePlan } = require("../app/agent-director");
const {
  assertDirectFastSegment,
  assertDirectFastSemanticSchedule,
  directFastSemanticScheduleDiagnostics,
  directFastSemanticScheduleRangeDiagnostics,
  directFastSemanticScheduleRangePrompt,
  assertDirectFastStorySpine,
  buildDirectFastFallbackSegment,
  buildDirectFastSemanticSegment,
  buildDirectFastFallbackSpine,
  normalizeDirectFastSemanticSpeakerUnits,
  directFastProductStartIndex,
  directFastReversalIndex,
  directFastSegmentRanges,
  directFastStorySpinePrompt,
  directFastUserPrompt,
  materializeDirectFastScript
} = require("../app/direct-fast-script");
const { planFilmSchedule } = require("../app/duration-contract");
const { dialogueUnitBudget } = require("../app/drama-writing-contract");
const { storyDensityTargets } = require("../app/script-craft");
const { adaptiveUploadedUnitDurations, representableTargetSeconds } = require("../app/script-duration");
const { allocateH3ShotSpeakers, h3AllowedSpeakersByShot } = require("../app/h3-speaker-allocation");
const {
  auditDramaSpec,
  ideaSignature,
  normalizeAnalysis,
  validateBlueprint,
  validateShotBatch,
  validateStoryBible
} = require("../app/workbench-workflow");

test("AI English execution mirrors survive blueprint-off normalization for an uncommon Chinese action", () => {
  const project = {
    generation: { engine: "hailuo-h3", qualityGatesEnabled: false },
    characters: [{ id: "C01", name: "宁宁" }, { id: "C02", name: "母亲" }]
  };
  const shot = {
    id: "S01", number: 1, duration: 10,
    visibleCharacterIds: ["C01", "C02"],
    action: "宁宁把折叠伞横挡在门缝前，门锁弹回",
    actionEn: "Ning wedges the folded umbrella across the door gap and the lock springs back.",
    stateBefore: "门缝正在合拢，雨伞尚未挡住门",
    stateBeforeEn: "The door gap is closing and the umbrella has not blocked it yet.",
    stateAfter: "折叠伞卡住门缝，门锁弹回",
    stateAfterEn: "The folded umbrella holds the gap open and the lock springs back.",
    subshots: [{
      number: 1, start: 0, end: 10, visibleCharacterIds: ["C01", "C02"],
      action: "宁宁把折叠伞横挡在门缝前，门锁弹回",
      actionEn: "Ning wedges the folded umbrella across the door gap and the lock springs back.",
      framingEn: "Tight medium shot on Ning's hands and the door gap.",
      cameraEn: "Slow push-in to the umbrella as the lock springs back.",
      stateBeforeEn: "The door gap is closing and the umbrella has not blocked it yet.",
      stateAfterEn: "The folded umbrella holds the gap open and the lock springs back.",
      soundEn: "Continuous hallway room tone with synchronized hinge and lock clicks.",
      dialogueTurns: [{ speakerId: "C01", listenerIds: ["C02"], text: "妈，先别关门。", onScreen: true }]
    }]
  };
  const plan = buildCameraTakePlan(project, shot);
  assert.equal(plan.takes.length, 1);
  assert.match(plan.takes[0].actionEn, /wedges the folded umbrella/i);
  assert.match(plan.takes[0].stateBeforeEn, /door gap is closing/i);
  assert.match(plan.takes[0].stateAfterEn, /lock springs back/i);
  assert.match(plan.takes[0].cameraEn, /Slow push-in/i);
  assert.match(plan.takes[0].soundEn, /hinge and lock clicks/i);
});

test("semantic schedule diagnostics keep a partial draft repairable", () => {
  const partial = {
    u: [
      { i: 1, duration: 8, beat: "母亲推门质问", before: "饭桌沉默", after: "账本被拍在桌上", dialogueLines: [[1, "这笔钱到底去了哪儿？"]], cutAfter: "女儿抬眼后切镜", dialogueContinuesToNext: false },
      { i: 2, duration: 7, beat: "女儿拿出收据", before: "账本在桌上", after: "收据摆到母亲面前", dialogueLines: [[2, "你先仔细看看这个日期。"]], cutAfter: "母亲伸手接过收据后切镜", dialogueContinuesToNext: false }
    ]
  };
  const diagnostics = directFastSemanticScheduleDiagnostics(partial, 30);
  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.failures, ["total:15/30"]);
  assert.throws(() => assertDirectFastSemanticSchedule(partial, 30), error => {
    assert.equal(error.code, "SCRIPT_SEMANTIC_SCHEDULE_CONTRACT_FAILED");
    assert.equal(error.noAutomaticRetry, false);
    assert.deepEqual(error.invalidSchedule, partial.u);
    return true;
  });
});

test("AI editorial duration may differ from the scaffold without becoming a repair failure", () => {
  const unit = {
    i: 1,
    duration: 13,
    beat: "母亲说完整句后，镜头转到女儿攥紧的手",
    before: "母女隔桌对峙",
    after: "女儿第一次看见母亲留下的证据",
    dialogueLines: [[1, "这封信我藏了二十年。", "压低声音慢慢说完，末尾停住呼吸", 2, 3.4, 0.8]],
    visualReserveSeconds: 4,
    durationRationale: "对白需要压低语速完整落地，并留给证据特写和听者反应",
    cutAfter: "女儿闭口看向信封，镜头推到日期后切镜",
    dialogueContinuesToNext: false
  };
  assert.equal(directFastSemanticScheduleRangeDiagnostics({ u: [unit] }, 1, 1, [10]).ok, false);
  const advisory = directFastSemanticScheduleRangeDiagnostics(
    { u: [unit] }, 1, 1, [10], { durationAdvisory: true }
  );
  assert.equal(advisory.ok, true);
  assert.equal(advisory.actualTotal, 13);
  assert.equal(directFastSemanticScheduleDiagnostics({ u: [unit] }, 10, { durationAdvisory: true }).ok, true);
});

test("semantic schedule treats dialogue density as guidance and preserves complete locked lines", () => {
  const invalid = {
    u: [{
      i: 1,
      duration: 10,
      beat: "楼梯争执升级",
      before: "父亲踩空后女儿托住他",
      after: "哥哥把救援指向房产争执",
      dialogueLines: [[3, "你是不是就等着爸出事，好把这套房子抓在手里？"], [1, "我在救爸，你第一句话却是房子。"]],
      cutAfter: "女儿护住父亲后哥哥的手停在半空",
      dialogueContinuesToNext: false
    }]
  };
  const diagnostics = directFastSemanticScheduleDiagnostics(invalid, 10);
  assert.equal(diagnostics.ok, true);
  assert.deepEqual(assertDirectFastSemanticSchedule(invalid, 10)[0].dialogueLines, invalid.u[0].dialogueLines);
});

test("semantic schedule identifies a silent final unit for adjacent-unit merging", () => {
  const diagnostics = directFastSemanticScheduleRangeDiagnostics({
    u: [{ i: 1, duration: 10, beat: "儿子拦住母亲", before: "母亲转身", after: "儿子握住她的手", cutAfter: "母亲停在门口", dialogueLines: [], dialogueContinuesToNext: false }]
  }, 1, 1, [10], { productStartNumber: 2 });
  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.invalidUnits[0].failures.includes("emptyDialogueLedger"));
});

test("semantic speaker labels normalize uniquely without changing locked dialogue text", () => {
  const source = [{ i: 1, dialogueLines: [["女儿（急促）", "爸，先抓紧我！"]] }, { i: 2, dialogueLines: [["儿子", "我来扶你。"]] }];
  const result = normalizeDirectFastSemanticSpeakerUnits(source);
  assert.deepEqual(result.units.map(unit => unit.dialogueLines), [[[1, "爸，先抓紧我！"]], [[2, "我来扶你。"]]]);
  assert.throws(() => normalizeDirectFastSemanticSpeakerUnits([{ i: 1, dialogueLines: [["旁白", "这不是对白。"]] }]), error => error.code === "SCRIPT_SEMANTIC_SPEAKER_INVALID");
  assert.throws(() => normalizeDirectFastSemanticSpeakerUnits([{ i: 1, dialogueLines: [["甲和乙", "一起说。"]] }]), error => error.code === "SCRIPT_SEMANTIC_SPEAKER_INVALID");
});

test("deterministic semantic fallback fits the current ten-second minimum dialogue budget", () => {
  const fallback = require("../app/direct-fast-script").buildDirectFastFallbackSemanticUnit({ topic: { hook: "现场冲突" }, index: 4, duration: 10, productStartNumber: 6 });
  const diagnostics = directFastSemanticScheduleRangeDiagnostics({ u: [fallback] }, 4, 4, [10, 10, 13, 10, 14, 10]);
  assert.equal(diagnostics.ok, true);
  assert.ok(fallback.dialogueLines.length >= 1);
  assert.doesNotMatch(fallback.beat, /行动推进\d+|情节推进/);
});

test("semantic scheduling ranges retain completed units and reject an incomplete provider prefix", () => {
  const durations = [10, 11, 12, 10, 10, 11];
  const unit = i => ({
    i,
    duration: durations[i - 1],
    beat: `beat-${i}`,
    before: `before-${i}`,
    after: `after-${i}`,
    dialogueLines: [[1, "请把这句完整台词现在说完。"]],
    cutAfter: "完整台词结束后的动作切点",
    dialogueContinuesToNext: false
  });
  const partial = directFastSemanticScheduleRangeDiagnostics({ u: [unit(1), unit(2)] }, 1, 3, durations);
  assert.equal(partial.ok, false);
  assert.ok(partial.failures.includes("count:2/3"));
  assert.ok(partial.failures.includes("S03:missing"));
  const complete = directFastSemanticScheduleRangeDiagnostics({ u: [unit(1), unit(2), unit(3)] }, 1, 3, durations);
  assert.equal(complete.ok, true);
  const prematureFinale = unit(3);
  prematureFinale.after = "画面定格收束全剧";
  const rejectedFinale = directFastSemanticScheduleRangeDiagnostics({ u: [prematureFinale] }, 3, 3, durations);
  assert.equal(rejectedFinale.ok, false);
  assert.ok(rejectedFinale.failures.includes("S03:prematureFinale"));
  const prompt = directFastSemanticScheduleRangePrompt({
    topic: { title: "范围续写" },
    product: { name: "测试商品", sellingPoints: "真实卖点" },
    totalSeconds: 64,
    start: 4,
    end: 6,
    durations,
    spine: {
      c: [
        { n: "林小雨", r: "护工，保护老人", d: "短发，蓝色工作服" },
        { n: "赵强", r: "施暴者，与林小雨对立", d: "黑夹克" },
        { n: "赵铁柱", r: "受助老人和证人", d: "灰白头发" }
      ],
      sc: [{ n: "老人家客厅", d: "冲突与证据发生地" }],
      b: [{ a: 1, z: 6, sc: 1, en: "林小雨已经挡在老人身前", g: "阻止赵强继续伤人", ex: "赵强被迫停手", h: "证据被拿到桌面" }]
    }
  });
  assert.match(prompt, /\[SEMANTIC_RANGE start=4 end=6\]/);
  assert.match(prompt, /"i":4,"duration":10/);
  assert.match(prompt, /范围外/);
  assert.match(prompt, /全剧人物编号表已经先于对白永久锁定/);
  assert.match(prompt, /"number":1,"id":"C01","name":"林小雨"/);
  assert.match(prompt, /绝不允许按本段出场顺序重新编号/);
  assert.match(prompt, /visibleCharacterNumbers 必须列出本镜画面中实际出现/);
  assert.match(prompt, /本句专属表演语气/);
  assert.match(prompt, /duration 只是断点恢复的初始节奏参考/);
  assert.match(prompt, /每项 duration 必须写成10–15秒整数/);
  assert.match(prompt, /不得承诺治愈、止痛、立刻见效/);
});

test("semantic schedule rejects a three-speaker unit before direct compilation", () => {
  const rejected = directFastSemanticScheduleRangeDiagnostics({ u: [{
    i: 1,
    duration: 10,
    beat: "三人同时争执，证人打断争吵",
    before: "合同摊在桌上",
    after: "三人都停下等待证据",
    dialogueLines: [[1, "你先把合同放下。"], [2, "这件事轮不到你管。"], [3, "日期和签名都在这里。"]],
    cutAfter: "证人把文件推到桌中央，三人停住动作后切镜",
    dialogueContinuesToNext: false
  }] }, 1, 1, [10]);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.failures.includes("S01:dialogueSpeakers"));
});

test("generic provider HTTP errors stop immediately when their body reports balance or credentials", () => {
  const { WorkbenchWorkflow } = require("../app/workbench-workflow");
  const workflow = new WorkbenchWorkflow({ store: {}, bridge: {} });
  assert.equal(workflow.autonomousPipelineExternalBlocker({
    code: "PROVIDER_HTTP_ERROR",
    message: "Your account org-test is suspended due to insufficient balance, please recharge."
  }), true);
  assert.equal(workflow.autonomousPipelineExternalBlocker({
    code: "PROVIDER_HTTP_ERROR",
    message: "invalid api key"
  }), true);
  assert.equal(workflow.autonomousPipelineExternalBlocker({
    code: "PROVIDER_HTTP_ERROR",
    message: "temporary upstream timeout"
  }), false);
});

test("uploaded dialogue timing produces variable 5-15 second units instead of fixed ten-second slots", () => {
  const durations = adaptiveUploadedUnitDurations([2.1, 3.2, 8.6, 1.8, 11.4, 4.7], 36, "puream-hailuo-h3", { engine: "hailuo-h3" });
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 36);
  assert.ok(durations.every(value => value >= 5 && value <= 15));
  assert.ok(new Set(durations).size > 1);
  assert.ok(durations.some(value => value !== 10));
});

function compactSegmentPayload(start, end) {
  return {
    c: [
      { n: "周桂兰", a: "58岁", r: "母亲", d: "瘦削、肩背微驼" },
      { n: "林晓梅", a: "32岁", r: "女儿", d: "短发、体态紧绷" },
      { n: "陈阿姨", a: "61岁", r: "邻居见证人", d: "圆阔脸、灰白短发" }
    ],
    sc: [
      { n: "旧家缝纫间", d: "缝纫机与婚纱工作区" },
      { n: "旧物房", d: "纸箱与手术单物证区" },
      { n: "社区工作室", d: "裁剪台与日常工作区" }
    ],
    s: Array.from({ length: end - start + 1 }, (_, offset) => {
      const number = start + offset;
      return {
        i: number,
        t: `推进${number}`,
        a: number === 1 ? "女儿踢开母亲，婚纱裙摆落地" : `人物完成第${number}个不同动作并改变现场关系`,
        bf: `第${number}镜开始前的关系状态`,
        af: `第${number}镜结束后形成不可逆新状态`,
        em: "克制→受刺激→情绪抬升→压住余震",
        f: ((number - 1) % 3) + 1,
        v: [((number - 1) % 3) + 1, (number % 3) + 1],
        d: [[1, "你凭什么这么做"], [2, "我从来没有骗过你"], [1, "证据已经摆在这里"], [2, "那就当面逐件核对"], [1, "你必须承担这后果"], [2, "我会用行动补回来"]]
      };
    })
  };
}

function strictSegmentPayload(start, end, durations = []) {
  const payload = compactSegmentPayload(start, end);
  payload.s = payload.s.map(shot => {
    const focus = Number(shot.f);
    const seconds = Math.max(5, Math.min(15, Number(durations[Number(shot.i) - 1]) || 10));
    const budget = dialogueUnitBudget(seconds, { solo: false });
    const turns = budget.targetTurns;
    const lines = [...shot.d];
    while (lines.length < turns) lines.push([focus, `第${lines.length + 1}句必须继续推进`]);
    const maxChars = Math.max(1, budget.targetChars - (Number(shot.i) === 1 ? 1 : 0));
    const base = lines.slice(0, turns);
    let remaining = maxChars;
    const dialogue = base.map(([speaker, text], index) => {
      const slots = base.length - index;
      const minimumRemaining = Math.max(0, slots - 1) * 5;
      const allowance = Math.max(5, Math.min([...String(text)].length, remaining - minimumRemaining));
      const trimmed = [...String(text).replace(/[，。！？!?；;：:…]/g, "")].slice(0, allowance).join("");
      remaining -= [...trimmed].length;
      return [speaker, trimmed];
    });
    const other = focus === 1 ? 2 : 1;
    return { ...shot, v: [focus, other], d: dialogue.map(([, text], index) => [index % 2 ? other : focus, text]) };
  });
  return payload;
}

function compactStorySpine(ranges) {
  const references = compactSegmentPayload(1, Math.max(...ranges.map(([, end]) => end)));
  return {
    c: references.c,
    sc: references.sc,
    b: ranges.map(([start, end], index) => ({
      a: start,
      z: end,
      sc: (index % references.sc.length) + 1,
      en: index ? `承接第${index}段留下的未解事实` : "婚纱受损后冲突已经爆发",
      g: `第${index + 1}段只推进一个新证据和动作`,
      ex: `第${index + 1}段形成无法退回的新关系状态`,
      h: index === ranges.length - 1 ? "人物用行动完成结局" : "末句和手部动作交给下一段"
    }))
  };
}

test("direct fast writing uses bounded continuous ranges and rejects acknowledgements or missing shots", () => {
  assert.deepEqual(directFastSegmentRanges(30), [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25], [26, 30]]);
  assert.deepEqual(directFastSegmentRanges(2), [[1, 2]]);
  const prompt = directFastUserPrompt({
    topic: { title: "门口真相" },
    product: { name: "护膝", sellingPoints: "日常支撑" },
    unitCount: 30,
    totalSeconds: 300,
    productStartNumber: 27,
    segmentStart: 6,
    segmentEnd: 10
  });
  assert.match(prompt, /第6-10镜/);
  assert.match(prompt, /第一个字符必须是\{/);
  assert.match(prompt, /禁止先说/);
  const payload = {
    c: [{}, {}, {}],
    sc: [{}],
    s: Array.from({ length: 5 }, (_, index) => ({ i: index + 6 }))
  };
  assert.equal(assertDirectFastSegment(payload, 6, 10), payload);
  assert.throws(
    () => assertDirectFastSegment({ c: [{}, {}, {}], sc: [{}], s: [{ i: 6 }, { i: 8 }] }, 6, 10),
    error => error.code === "SCRIPT_DIRECT_SEGMENT_CONTRACT_FAILED" && error.retryRequiresExplicitResume === true
  );
  assert.throws(
    () => assertDirectFastSegment("我会按要求编写", 6, 10),
    error => error.code === "SCRIPT_DIRECT_SEGMENT_CONTRACT_FAILED"
  );
});

test("global story spine locks cast, scenes and causal handoffs before parallel segments", () => {
  const ranges = directFastSegmentRanges(60);
  const spine = compactStorySpine(ranges);
  assert.equal(assertDirectFastStorySpine(spine, ranges), spine);
  const prompt = directFastStorySpinePrompt({
    topic: { title: "退休金里的秘密", hook: "孙女在警局拍桌质问爷爷。" },
    product: { name: "书籍", sellingPoints: "按用户上传页面阅读" },
    unitCount: 60,
    totalSeconds: 600,
    productStartNumber: 58,
    segmentRanges: ranges
  });
  assert.match(prompt, /唯一全剧骨架/);
  assert.match(prompt, /相邻段必须满足上一段ex\/h能够因果承接下一段en/);
  assert.match(prompt, /禁止写场景名、SC01、字符串数字或0/);
  const segmentPrompt = directFastUserPrompt({
    topic: { title: "退休金里的秘密" },
    product: { name: "书籍", sellingPoints: "按用户上传页面阅读" },
    unitCount: 60,
    totalSeconds: 600,
    productStartNumber: 58,
    segmentStart: 6,
    segmentEnd: 10,
    spine
  });
  assert.match(segmentPrompt, /全剧人物编号与场景不可改写/);
  assert.match(segmentPrompt, /根对象严格只含s/);
  const segment = { s: strictSegmentPayload(6, 10).s };
  assert.equal(assertDirectFastSegment(segment, 6, 10, { characters: spine.c, scenes: spine.sc, strict: true }), segment);
});

test("local fallback compiles strict five and ten minute segment contracts", () => {
  const topic = {
    title: "门口真相",
    relationship: "母女",
    hook: "住手！你凭什么推她？",
    logline: "女儿误解母亲，随后按证据查明真相。",
    proofChain: "日期、签名和证言相互印证。",
    reversal: "女儿确认母亲一直替她承担。",
    emotionalPayoff: "女儿用持续行动修复关系。"
  };
  const product = { name: "护膝", description: "日常支撑", sellingPoints: "贴合膝部、活动支撑" };
  for (const seconds of [300, 600]) {
    const schedule = planFilmSchedule(seconds, "puream-hailuo-h3", { engine: "hailuo-h3" });
    const ranges = directFastSegmentRanges(schedule.unitCount);
    const spine = buildDirectFastFallbackSpine({ topic, ranges });
    assert.equal(assertDirectFastStorySpine(spine, ranges), spine);
    for (const [start, end] of ranges) {
      const segmentPayload = buildDirectFastFallbackSegment({
        spine,
        topic,
        segmentStart: start,
        segmentEnd: end,
        unitDurations: schedule.suggestedDurations
      });
      assert.equal(assertDirectFastSegment(segmentPayload, start, end, {
        characters: spine.c,
        scenes: spine.sc,
        durations: schedule.suggestedDurations,
        strict: true
      }), segmentPayload);
    }
    const completedPayload = {
      ...spine,
      spineLocked: true,
      s: ranges.flatMap(([start, end]) => buildDirectFastFallbackSegment({
        spine,
        topic,
        segmentStart: start,
        segmentEnd: end,
        unitDurations: schedule.suggestedDurations
      }).s)
    };
    const materialized = materializeDirectFastScript({ payload: completedPayload, topic, product, filmSchedule: schedule });
    const options = { targetDurationSeconds: seconds, expectedUnitCount: schedule.unitCount };
    const storyBible = validateStoryBible(materialized.storyBible, options);
    const blueprint = validateBlueprint({ ...storyBible, shotPlan: materialized.plans }, product.name, options);
    const assignments = allocateH3ShotSpeakers(blueprint.shotPlan, blueprint.characters, 2);
    const shots = validateShotBatch({ shots: materialized.rawShots }, blueprint.shotPlan, product.name, "hailuo-h3", {
      generationMode: "keyframe",
      characters: blueprint.characters,
      maxSpeakingCharacters: 2,
      requireReferenceDialogueFlow: true,
      allowedSpeakersByShot: h3AllowedSpeakersByShot(assignments)
    });
    const normalized = normalizeAnalysis({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, {
      product,
      generation: { targetDurationSeconds: seconds, engine: "hailuo-h3", mode: "keyframe" }
    });
    const audit = auditDramaSpec(normalized, { productName: product.name, sellingPoints: product.sellingPoints });
    assert.equal(audit.ok, true, audit.failures.map(item => item.message).join("；"));
  }
});

test("the direct compiler supports a real 20-second two-shot smoke drama", () => {
  const topic = {
    title: "门口真相",
    relationship: "母女",
    logline: "女儿在门口误解母亲，随后从证据中看见真相。",
    hook: "女儿推开母亲手里的旧信。",
    proofChain: "信封日期和邻居证言互相印证。",
    reversal: "女儿看清母亲一直在替她承担。",
    emotionalPayoff: "女儿停止争辩并主动修复关系。"
  };
  const product = { name: "护膝", description: "日常支撑用品", sellingPoints: "贴合、可调节" };
  const filmSchedule = planFilmSchedule(20, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  assert.equal(filmSchedule.unitCount, 2);
  const payload = compactSegmentPayload(1, 2);
  const materialized = materializeDirectFastScript({ payload, topic, product, filmSchedule });
  assert.equal(materialized.rawShots.length, 2);
  assert.equal(materialized.plans.reduce((sum, shot) => sum + shot.duration, 0), 20);
  assert.deepEqual(materialized.rawShots.map(shot => shot.id), ["S01", "S02"]);
  assert.equal(materialized.plans.at(-1).mainlineStage, "main_reversal");
  const firstShot = materialized.rawShots[0];
  assert.deepEqual([...new Set(firstShot.dialogueTurns.map(turn => turn.speakerId))], ["C01", "C02"]);
  const cameraPlan = buildCameraTakePlan({ characters: materialized.storyBible.characters }, firstShot, { mode: "storyboard_sheet" });
  const consecutiveSpeakerRuns = firstShot.dialogueTurns.reduce((count, turn, index, turns) => (
    count + (index === 0 || turn.speakerId !== turns[index - 1].speakerId || turn.onScreen !== turns[index - 1].onScreen ? 1 : 0)
  ), 0);
  assert.equal(cameraPlan.takes.length, consecutiveSpeakerRuns, "complete adjacent lines by the same speaker must share one atomic camera segment");
  assert.equal(cameraPlan.generationBlocks.length, 1, "a normal complete shot must remain one paid H3 request");
  assert.deepEqual(
    cameraPlan.takes.flatMap(take => take.dialogueTurns.map(turn => turn.text)),
    firstShot.dialogueTurns.map(turn => turn.text),
    "every dialogue atom must remain complete and in source order"
  );
  assert.deepEqual(cameraPlan.generationBlocks.flatMap(block => block.takeIds), cameraPlan.takes.map(take => take.id));
  assert.equal(cameraPlan.generationBlocks.every(block => block.speakerIds.length <= 3), true);
  assert.equal(cameraPlan.generationBlocks.every(block => block.mouthOwnerIds.length <= 3), true);
  assert.equal(cameraPlan.generationBlocks.every(block => block.cameraOwnerIds.length <= 5), true);
});

test("the minimum 30-second AI contract has room for a late reversal and a later product shot", () => {
  const filmSchedule = planFilmSchedule(30, "puream-hailuo-h3", { preferredUnit: 5, engine: "hailuo-h3" });
  assert.equal(filmSchedule.unitCount, 3);
  assert.deepEqual(filmSchedule.suggestedDurations, [10, 10, 10]);
  assert.equal(directFastReversalIndex(filmSchedule.unitCount), 1, "zero-based index1 means shot2: conflict must be established before the reversal");
  assert.equal(directFastProductStartIndex(filmSchedule.unitCount), 2, "shot3 follows the reversal and carries product plus visible ending");
  assert.ok(directFastProductStartIndex(filmSchedule.unitCount) > directFastReversalIndex(filmSchedule.unitCount));
  assert.equal(directFastProductStartIndex(30), 27);
});

test("a 30-second product result keeps the human ending and explicit character voice gender", () => {
  const filmSchedule = planFilmSchedule(30, "puream-hailuo-h3", { preferredUnit: 5, engine: "hailuo-h3" });
  const payload = compactSegmentPayload(1, filmSchedule.unitCount);
  payload.c = [
    { n: "王建国", g: "男", a: "68岁", r: "丈夫，妻子陪同康复训练", d: "短灰发、身形清瘦" },
    { n: "李梅", g: "女", a: "64岁", r: "妻子，照顾丈夫", d: "齐耳灰发、体态稳重" },
    { n: "王敏", g: "女", a: "36岁", r: "女儿，见证并搀扶父亲", d: "低马尾、动作利落" }
  ];
  payload.s[filmSchedule.unitCount - 1] = {
    ...payload.s[filmSchedule.unitCount - 1],
    a: "王建国戴好护膝，在妻子与女儿的注视下扶住栏杆稳稳站起",
    af: "王建国完成站立动作，向家人点头，三人决定按日常计划继续练习",
    f: 1,
    v: [1, 2],
    d: [[1, "我自己试着站起来。", "平静而坚定地低声说，语速放慢，重音落在‘自己’，句尾稳稳收住"]]
  };
  const materialized = materializeDirectFastScript({
    payload,
    topic: { title: "重新站起", hook: "父亲在门口险些跌倒。", reversal: "家人终于看清误会。", proofChain: "旧记录与现场动作互相印证。" },
    product: { name: "舒缓护膝", description: "日常支撑用品", sellingPoints: "轻薄贴合、佩戴稳固" },
    filmSchedule
  });
  const endingPlan = materialized.plans.at(-1);
  const endingShot = materialized.rawShots.at(-1);
  assert.equal(endingPlan.productShotType, "product_result");
  assert.ok(endingPlan.visibleCharacterIds.length > 0);
  assert.match(endingPlan.action, /王建国.*稳稳站起/);
  assert.ok(endingShot.subshots.every(item => !/product_packshot/.test(item.shotType)));
  assert.match(materialized.storyBible.characters[0].voiceDescription, /男声/);
  assert.match(materialized.storyBible.characters[1].voiceDescription, /女声/);
});

test("total film duration is unbounded while every text request stays in five-shot resumable segments", () => {
  const topic = {
    title: "旧信里的真相",
    hook: "女儿抢走母亲手里的旧信。",
    proofChain: "日期、签名和证人行动互相印证。",
    reversal: "女儿看清母亲一直替她承担。"
  };
  const product = { name: "家庭沟通训练图书", description: "用户上传的纸质书", sellingPoints: "按已有内容阅读" };
  for (const totalSeconds of [180, 300, 600, 900, 1800, 7200]) {
    const filmSchedule = planFilmSchedule(totalSeconds, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
    assert.equal(filmSchedule.totalSeconds, totalSeconds);
    assert.equal(filmSchedule.unitCount, totalSeconds / 10);
    assert.equal(filmSchedule.unitDurations.reduce((sum, value) => sum + value, 0), totalSeconds);
    const segments = directFastSegmentRanges(filmSchedule.unitCount);
    assert.equal(segments.length, Math.ceil(filmSchedule.unitCount / 5));
    assert.ok(segments.every(([start, end]) => end - start + 1 <= 5));
    assert.deepEqual(segments.at(-1), [Math.floor((filmSchedule.unitCount - 1) / 5) * 5 + 1, filmSchedule.unitCount]);
    assert.equal(representableTargetSeconds(totalSeconds, "puream-hailuo-h3"), totalSeconds);

    // Full local materialization/audit is intentionally exercised through
    // 30 minutes; the 2-hour case proves scheduling and chunking stay unbounded
    // without allocating a heavyweight production fixture during every test.
    if (totalSeconds <= 1800) {
      const materialized = materializeDirectFastScript({
        payload: compactSegmentPayload(1, filmSchedule.unitCount),
        topic,
        product,
        filmSchedule
      });
      const density = storyDensityTargets(totalSeconds, filmSchedule.unitCount);
      assert.ok(materialized.storyBible.scenes.length >= density.sceneMin);
      assert.ok(materialized.storyBible.scenes.length <= density.sceneMax);
      const options = { targetDurationSeconds: totalSeconds, expectedUnitCount: filmSchedule.unitCount };
      const storyBible = validateStoryBible(materialized.storyBible, options);
      const blueprint = validateBlueprint({ ...storyBible, shotPlan: materialized.plans }, product.name, options);
      assert.equal(blueprint.shotPlan.length, filmSchedule.unitCount);
      assert.equal(blueprint.shotPlan.reduce((sum, shot) => sum + shot.duration, 0), totalSeconds);
      assert.ok(materialized.rawShots.filter(shot => shot.dialogueTurns.length).every(shot => (
        shot.dialogueTurns.every(turn => turn.text && turn.delivery && turn.body && turn.listenerBeat)
      )));
      if ([300, 600, 1800].includes(totalSeconds)) {
        const assignments = allocateH3ShotSpeakers(blueprint.shotPlan, blueprint.characters, 2);
        const shots = validateShotBatch({ shots: materialized.rawShots }, blueprint.shotPlan, product.name, "hailuo-h3", {
          generationMode: "keyframe",
          characters: blueprint.characters,
          maxSpeakingCharacters: 2,
          requireReferenceDialogueFlow: true,
          allowedSpeakersByShot: h3AllowedSpeakersByShot(assignments)
        });
        const normalized = normalizeAnalysis({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, {
          product,
          generation: { targetDurationSeconds: totalSeconds, engine: "hailuo-h3", mode: "keyframe" }
        });
        const audit = auditDramaSpec(normalized, { productName: product.name, sellingPoints: product.sellingPoints });
        assert.equal(audit.ok, true, audit.failures.map(item => item.message).join("；"));
      }
    }
  }
});

test("the direct compiler adapts product actions by category instead of forcing every product onto a knee", () => {
  const filmSchedule = planFilmSchedule(300, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  const topic = { title: "旧信里的真相", hook: "女儿抢走母亲手里的旧信。", proofChain: "日期和签名互相印证。", reversal: "女儿看清母亲一直替她承担。" };
  const materialized = materializeDirectFastScript({
    payload: compactSegmentPayload(1, 30),
    topic,
    product: { name: "书籍《红楼十二层》", description: "用户上传的纸质书", sellingPoints: "按书中已有内容阅读" },
    filmSchedule
  });
  const productShots = materialized.rawShots.filter(shot => shot.productMention);
  assert.equal(productShots.length, 3);
  const productText = JSON.stringify(productShots);
  assert.match(productText, /翻到已标记的一页|阅读与信息核对/);
  assert.doesNotMatch(productText, /膝部|绑带|跪地量裁|戴好/);
});

test("legacy fixed-schedule flag also uses one complete screenplay request without automatic range repair", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-firstpass-legacy-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const store = new WorkbenchStore(root);
  const project = store.createProject("旧入口一致性", {inputMode:"ai",executionMode:"step",scriptFormat:"dialogue",scriptFormatConfirmed:true});
  store.patchProject(project.id,{productionPlan:{inputMode:"ai",commerceMode:"none",scriptFormat:"dialogue",scriptFormatConfirmed:true},ideation:{topics:[{id:"T1",title:"回家",logline:"母子化解误会"}],selectedTopicId:"T1",status:"ready"}});
  const line="儿子（对母亲；焦急；扶住门框）：妈，先别走，我把那封信找到了。";
  // This tests request count, so provide a complete-duration response under
  // the current original-script contract rather than a two-line micro-script.
  const fixtureLines=[line];
  while(require('../app/film-runtime-policy').measure(fixtureLines.join('\n')).seconds<490)fixtureLines.push('母亲（对儿子；含泪；接稳信封）：你愿意听，我就不走了，我把信上的日期讲清楚。');
  const calls=[];
  const workflow=new (require("../app/workbench-workflow").WorkbenchWorkflow)({store,bridge:{},locateFfmpeg:()=>"",stagingRoot:root,textGenerator:async(_config,messages)=>{
    const input=JSON.parse(messages.filter(m=>m.role==="user").at(-1).content);calls.push(input);
    if(input.narrativeRequirements)return {commerceProfile:{},plan:{title:"回家",logline:"母子化解误会",cast:[{name:"儿子",role:"儿子"},{name:"母亲",role:"母亲"}],locations:[{name:"门厅"}],scenes:[{id:"S01"}],ending:"两人留在家中"},parts:[{sceneId:"S01",scriptText:fixtureLines.join('\n'),endState:"母亲持信，母子在门厅"}]};
    return {ok:true,issues:[],checks:[{dimension:"因果",evidence:line}],openingCheck:{ok:true,quote:line,bond:"母子",reason:"离家冲突直接出现"}};
  }});
  let delivered=0;
  workflow.prepareWrittenScriptForConfirmation=async id=>{delivered++;return store.getProject(id);};
  const result=await workflow.generateCompleteScript(project.id,{legacyFixedSchedule:true});
  assert.equal(delivered,1,'legacy writing entry also proceeds to the complete prompt confirmation preparation');
  assert.equal(calls.length,2,"one complete generation plus one independent review");
  assert.ok(calls[0].narrativeRequirements);assert.equal(calls[0].requiredOutput,undefined);
  assert.ok(calls[1].sourceLines);
  assert.equal(result.script.firstPassQuality.generationCalls,1);
  assert.equal(result.script.firstPassQuality.automaticRewriteCalls,0);
  assert.equal(result.script.reviewStatus,"ready");
  assert.equal(result.currentStage,"script");
  assert.equal(result.shots.length,0,"the isolated delivery stub does not submit media");
  assert.equal(result.generation.durationLocked,false);
});

test("local semantic materializer preserves locked lines byte-for-byte and satisfies strict direct contracts", () => {
  const semanticUnits = [
    { i: 1, duration: 10, beat: "女儿逼问合同去向", before: "合同不见", after: "母亲指明抽屉", dialogueLines: [[1, "你把合同藏哪儿了？"], [2, "就在抽屉最下面。"]], cutAfter: "母亲说完，女儿拉开抽屉后切镜", dialogueContinuesToNext: false },
    { i: 2, duration: 10, beat: "女儿看见代签说明", before: "母亲指明抽屉", after: "女儿确认自己误会", dialogueLines: [[1, "这份代签说明是真的？"], [2, "日期和签名都在这里。"]], cutAfter: "母亲说完，女儿停住动作后切镜", dialogueContinuesToNext: false }
  ];
  const spine = compactStorySpine([[1, 2]]);
  const payload = buildDirectFastSemanticSegment({ spine, topic: { title: "合同真相" }, segmentStart: 1, segmentEnd: 2, unitDurations: [10, 10], semanticUnits });
  assert.equal(assertDirectFastSegment(payload, 1, 2, {
    characters: spine.c,
    scenes: spine.sc,
    durations: [10, 10],
    strict: true,
    semanticUnits,
    requireCompleteDialogue: true
  }), payload);
  assert.deepEqual(payload.s.map(shot => shot.d.map(line => line.slice(0, 2))), semanticUnits.map(unit => unit.dialogueLines));
});

test("direct semantic and final materialization retain all three authored visible people without inventing a fallback actor", () => {
  const spine = compactStorySpine([[1, 3]]);
  const semanticUnits = [1, 2, 3].map(i => ({ i, duration: 10, beat: "母亲出示回单，女儿吃惊，证人在门旁闭口点头", before: "回单握在母亲手中", after: "回单摆在桌面，女儿停止指责", visibleCharacterNumbers: [1, 2, 3], dialogueLines: [[1, "缴费回单就在这里。", "快速而坚定地说明事实", 2]], cutAfter: "女儿看清回单后抬头", dialogueContinuesToNext: false }));
  const payload = buildDirectFastSemanticSegment({ spine, topic: { title: "回单证人" }, segmentStart: 1, segmentEnd: 3, unitDurations: [10, 10, 10], semanticUnits });
  assert.deepEqual(payload.s[0].v, [1, 2, 3]);
  assert.equal(assertDirectFastSegment(payload, 1, 3, { characters: spine.c, scenes: spine.sc, durations: [10, 10, 10], strict: true, semanticUnits }), payload);
  const materialized = materializeDirectFastScript({ payload, topic: { title: "回单证人" }, product: { name: "台灯", sellingPoints: "旋钮调节" }, filmSchedule: planFilmSchedule(30, "puream-hailuo-h3", { engine: "hailuo-h3" }) });
  assert.deepEqual(materialized.plans[0].visibleCharacterIds, ["C01", "C02", "C03"]);
  assert.deepEqual(materialized.rawShots[0].subshots[0].visibleCharacterIds, ["C01", "C02", "C03"]);
  const duplicate = structuredClone(payload);
  duplicate.s[0].v = [1, 1, 3];
  assert.throws(() => assertDirectFastSegment(duplicate, 1, 3, { characters: spine.c, scenes: spine.sc, durations: [10, 10, 10], strict: true, semanticUnits }), error => error.strictFailures?.some(item => item.failed.includes("visible")));
});

test("semantic materialization keeps a silent listener visible and gives every line a concrete performance", () => {
  const spine = compactStorySpine([[1, 1]]);
  spine.c[0].n = "陆天";
  spine.c[1].n = "陆大强";
  spine.c[2].n = "李玉兰";
  const semanticUnits = [{
    i: 1,
    duration: 10,
    beat: "陆天俯身给李玉兰戴好护膝并扶住她起身",
    before: "李玉兰双腿发抖无法站稳",
    after: "李玉兰在陆天搀扶下站稳",
    visibleCharacterNumbers: [1, 3],
    dialogueLines: [[1, "奶奶，我扶着您慢慢走。", "心疼地轻声安抚，音量低、语速慢，重音落在慢慢走，句尾留半拍"]],
    cutAfter: "李玉兰握住陆天手臂并站稳后切镜",
    dialogueContinuesToNext: false
  }];
  const payload = buildDirectFastSemanticSegment({
    spine,
    topic: { title: "雪地搀扶" },
    segmentStart: 1,
    segmentEnd: 1,
    unitDurations: [10],
    productStartNumber: 2,
    semanticUnits
  });
  assert.deepEqual(payload.s[0].v, [1, 3]);
  assert.equal(payload.s[0].d[0][0], 1);
  assert.equal(payload.s[0].d[0][1], "奶奶，我扶着您慢慢走。");
  assert.match(payload.s[0].d[0][2], /心疼|音量低|语速慢/);
  assert.doesNotMatch(payload.s[0].d[0][2], /语气贴合当前冲突|自然说/);
});

test("semantic dialogue carries the authored listener instead of guessing another visible character", () => {
  const spine = compactStorySpine([[1, 1]]);
  spine.c[0].n = "林素琴";
  spine.c[1].n = "周岚";
  spine.c[2].n = "陈建国";
  const semanticUnits = [{
    i: 1,
    duration: 10,
    beat: "林素琴和陈建国把缴费记录交给周岚核对",
    before: "周岚仍不相信母亲",
    after: "周岚看清记录并停止指责",
    visibleCharacterNumbers: [1, 3],
    dialogueLines: [
      [1, "孩子夜里没人接，我就带回家。", "林素琴面对周岚低声承认，语速放慢，句尾泄气"],
      [3, "缴费人一直是她。", "陈建国平静核实，重音落在一直，句尾收住", 2]
    ],
    cutAfter: "周岚看清姓名后抬眼，停顿0.5秒切镜",
    dialogueContinuesToNext: false
  }];
  const payload = buildDirectFastSemanticSegment({
    spine,
    topic: { title: "缴费单真相" },
    segmentStart: 1,
    segmentEnd: 1,
    unitDurations: [10],
    productStartNumber: 2,
    semanticUnits
  });
  payload.spineLocked = true;
  assert.equal(payload.s[0].d[0][5], 2, "legacy three-field dialogue should infer the named listener from delivery");
  assert.equal(payload.s[0].d[1][5], 2, "the explicit listener must survive deterministic compilation");
  const materialized = materializeDirectFastScript({
    payload,
    topic: { title: "缴费单真相" },
    product: { name: "护眼台灯", sellingPoints: "柔和阅读光" },
    filmSchedule: { unitCount: 1, totalSeconds: 10, suggestedDurations: [10] }
  });
  assert.deepEqual(materialized.rawShots[0].dialogueTurns.map(turn => turn.listenerIds), [["C02"], ["C02"]]);
  assert.ok(materialized.rawShots[0].dialogueTurns.every(turn => /周岚/.test(turn.listenerBeat)));
});

test("final semantic compilation heals placeholders and dangling local truncation without a paid rewrite", () => {
  const spine = compactStorySpine([[1, 6]]);
  const topic = {
    title: "雨夜门口那盏没熄的灯",
    settlementAction: "女儿把灯擦干放回书桌，第一次主动请母亲留下吃饭。",
    emotionalPayoff: "误解被具体证据击穿，和解以可见行动兑现。"
  };
  const payload = buildDirectFastSemanticSegment({
    spine,
    topic,
    segmentStart: 6,
    segmentEnd: 6,
    unitDurations: [5, 7, 7, 10, 5, 5],
    semanticUnits: [{
      i: 6,
      duration: 5,
      beat: "行动推进6",
      before: "女儿接住抹布并面对母亲",
      after: "护眼台灯被重新放回书桌，女儿邀请母亲留下吃饭，母亲接受并坐到",
      visibleCharacterNumbers: [1, 2],
      dialogueLines: [[1, "你把话说清。", "低声追问，句尾等待回应", 2]],
      cutAfter: "完成收束",
      dialogueContinuesToNext: false
    }]
  });
  const shot = payload.s[0];
  assert.doesNotMatch(`${shot.t} ${shot.a} ${shot.af}`, /行动推进6|完成收束|接受并坐到$/);
  assert.match(shot.a, /把灯擦干放回书桌|留下吃饭/);
  assert.match(shot.af, /和解以可见行动兑现/);
  assert.equal(shot.d.length, 0, "an isolated ending question should become a silent visible settlement, not reopen the story");
});

test("semantic range prompt locks speaker, spoken text, delivery and listener into separate fields", () => {
  const prompt = directFastSemanticScheduleRangePrompt({
    topic: { title: "合同真相", settlementAction: "女儿归还合同并当面道歉。", emotionalPayoff: "关系以行动修复。" },
    product: { name: "台灯", sellingPoints: "旋钮调节" },
    totalSeconds: 10,
    start: 1,
    end: 1,
    durations: [10],
    spine: compactStorySpine([[1, 1]])
  });
  assert.match(prompt, /明确听者 number/);
  assert.match(prompt, /只有第二项属于口型与配音/);
  assert.match(prompt, /settlementAction/);
  assert.match(prompt, /禁止“行动推进N/);
});

test("semantic shots preserve every locked dialogue sentence and reject cross-shot fragments", () => {
  const semanticUnits = [
    {
      i: 1,
      duration: 10,
      beat: "女儿逼问合同去向",
      before: "合同不见",
      after: "母亲指明抽屉",
      dialogueLines: [[1, "你把合同藏哪儿了？"], [2, "就在抽屉最下面。"]],
      cutAfter: "母亲说完，女儿停顿0.6秒后拉开抽屉",
      dialogueContinuesToNext: false
    },
    {
      i: 2,
      duration: 10,
      beat: "女儿看见代签说明",
      before: "母亲指明抽屉",
      after: "女儿确认自己误会",
      dialogueLines: [[1, "这份代签说明是真的？"], [2, "日期和签名都在。"]],
      cutAfter: "母亲说完，女儿看清签名并抬眼反应0.5秒",
      dialogueContinuesToNext: false
    }
  ];
  assert.equal(assertDirectFastSemanticSchedule({ u: semanticUnits }, 20), semanticUnits);

  const payload = strictSegmentPayload(1, 2, [10, 10]);
  payload.s[0].d = semanticUnits[0].dialogueLines;
  payload.s[1].d = semanticUnits[1].dialogueLines;
  assert.equal(assertDirectFastSegment(payload, 1, 2, {
    characters: payload.c,
    scenes: payload.sc,
    durations: [10, 10],
    strict: true,
    semanticUnits,
    requireCompleteDialogue: true
  }), payload);

  const cutOff = structuredClone(payload);
  cutOff.s[0].d[0][1] = "你把合同藏哪儿";
  cutOff.s[1].d[0][1] = "了？";
  assert.throws(
    () => assertDirectFastSegment(cutOff, 1, 2, {
      characters: cutOff.c,
      scenes: cutOff.sc,
      durations: [10, 10],
      strict: true,
      semanticUnits,
      requireCompleteDialogue: true
    }),
    error => error.code === "SCRIPT_DIRECT_SEGMENT_CONTRACT_FAILED"
      && error.strictFailures.some(item => item.failed.includes("semanticDialogue"))
  );
});

test("one-call compact script is locally expanded into a 300-second production-ready drama", () => {
  const topic = {
    id: "TOPIC_01",
    title: "跪地母亲",
    relationship: "母女",
    storyMechanism: "sacrifice_repaid",
    logline: "女儿误解跪地缝婚纱的母亲，十年后从手术单和旧婚纱看见她延误治疗的牺牲。",
    hook: "女儿踢开跪地缝纫的母亲，婚纱裙摆从她手里滑落。",
    highlights: ["母亲忍痛缝到天亮", "手术单日期揭开牺牲", "女儿用行动偿还"],
    valueStatement: "真正的亲情要靠看见和行动回报。",
    protagonistWound: "母亲长期被轻视后习惯隐忍。",
    falseBelief: "只要牺牲自己就能换来孩子体面。",
    themeObject: "带血针孔的婚纱裙摆",
    proofChain: "手术单日期、婚纱血渍和邻居证言形成证据链。",
    reversal: "女儿确认母亲为婚礼错过治疗并公开承担错误。",
    emotionalPayoff: "女儿用持续行动照顾自己也帮助其他母亲。"
  };
  const product = {
    name: "硅胶护膝",
    description: "日常活动支撑",
    sellingPoints: "贴合膝部、活动时提供稳定支撑；不虚构治疗功效"
  };
  const filmSchedule = planFilmSchedule(300, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  const payload = {
    c: [
      { n: "周桂兰", a: "58岁", r: "母亲", d: "瘦削、肩背微驼" },
      { n: "林晓梅", a: "32岁", r: "女儿", d: "短发、体态紧绷" },
      { n: "陈阿姨", a: "61岁", r: "邻居见证人", d: "圆阔脸、灰白短发" }
    ],
    sc: [
      { n: "旧家缝纫间", d: "缝纫机与婚纱工作区" },
      { n: "旧物房", d: "纸箱与手术单物证区" },
      { n: "社区工作室", d: "裁剪台与日常工作区" }
    ],
    s: Array.from({ length: 30 }, (_, index) => ({
      i: index + 1,
      t: `推进${index + 1}`,
      a: index === 0 ? "女儿踢开母亲，婚纱裙摆落地" : `人物完成第${index + 1}个不同动作并改变现场关系`,
      bf: `第${index + 1}镜开始前的关系状态`,
      af: `第${index + 1}镜结束后形成不可逆新状态`,
      em: "克制→受刺激→情绪抬升→压住余震",
      f: (index % 3) + 1,
      v: [(index % 3) + 1, ((index + 1) % 3) + 1],
      d: [[1, "你把话说清"], [2, "别再拿话骗我"], [1, "我已经看见了"], [2, "这次没有退路"], [1, "你现在就回答"], [2, "说完我们再走"]]
    }))
  };
  const strictPayload = {
    ...payload,
    spineLocked: true,
    s: directFastSegmentRanges(filmSchedule.unitCount)
      .flatMap(([start, end]) => strictSegmentPayload(start, end, filmSchedule.suggestedDurations).s)
  };
  const materialized = materializeDirectFastScript({ payload: strictPayload, topic, product, filmSchedule });
  const options = { targetDurationSeconds: 300, expectedUnitCount: filmSchedule.unitCount };
  const storyBible = validateStoryBible(materialized.storyBible, options);
  const blueprint = validateBlueprint({ ...storyBible, shotPlan: materialized.plans }, product.name, options);
  const assignments = allocateH3ShotSpeakers(blueprint.shotPlan, blueprint.characters, 2);
  const shots = validateShotBatch({ shots: materialized.rawShots }, blueprint.shotPlan, product.name, "hailuo-h3", {
    generationMode: "keyframe",
    characters: blueprint.characters,
    maxSpeakingCharacters: 2,
    requireReferenceDialogueFlow: true,
    allowedSpeakersByShot: h3AllowedSpeakersByShot(assignments)
  });
  const normalized = normalizeAnalysis({ story: blueprint.story, characters: blueprint.characters, scenes: blueprint.scenes, shots }, {
    product,
    generation: { targetDurationSeconds: 300, engine: "hailuo-h3", mode: "keyframe" }
  });
  const audit = auditDramaSpec(normalized, { productName: product.name, sellingPoints: product.sellingPoints });
  assert.equal(shots.length, filmSchedule.unitCount);
  assert.equal(shots.reduce((sum, shot) => sum + shot.duration, 0), 300);
  assert.equal(audit.ok, true, audit.failures.map(item => item.message).join("；"));
});
