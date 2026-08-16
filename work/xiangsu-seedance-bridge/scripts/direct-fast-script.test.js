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
  assertDirectFastStorySpine,
  buildDirectFastFallbackSegment,
  buildDirectFastFallbackSpine,
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
const { representableTargetSeconds } = require("../app/script-duration");
const { allocateH3ShotSpeakers, h3AllowedSpeakersByShot } = require("../app/h3-speaker-allocation");
const {
  auditDramaSpec,
  normalizeAnalysis,
  validateBlueprint,
  validateShotBatch,
  validateStoryBible
} = require("../app/workbench-workflow");

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
  assert.equal(cameraPlan.takes.length, 5, "five alternating dialogue turns must remain five camera segments");
  assert.equal(cameraPlan.generationBlocks.length, 1, "the same exchange must remain one continuous H3 request");
  assert.deepEqual(cameraPlan.generationBlocks[0].takeIds, cameraPlan.takes.map(take => take.id));
});

test("the minimum 30-second AI contract has room for a late reversal and a later product shot", () => {
  const filmSchedule = planFilmSchedule(30, "puream-hailuo-h3", { preferredUnit: 5, engine: "hailuo-h3" });
  assert.equal(filmSchedule.unitCount, 6);
  assert.deepEqual(filmSchedule.suggestedDurations, [5, 5, 5, 5, 5, 5]);
  assert.equal(directFastReversalIndex(filmSchedule.unitCount), 4);
  assert.equal(directFastProductStartIndex(filmSchedule.unitCount), 5);
  assert.ok(directFastProductStartIndex(filmSchedule.unitCount) > directFastReversalIndex(filmSchedule.unitCount));
  assert.equal(directFastProductStartIndex(30), 27);
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

test("failed direct segment falls back locally without restarting successful Agent segments", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-direct-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const imagePath = path.join(root, "product.png");
  fs.writeFileSync(imagePath, Buffer.from("product"));
  const created = store.createProject("分段续写", {
    inputMode: "ai",
    executionMode: "step",
    scriptFormat: "dialogue",
    scriptFormatConfirmed: true,
    targetDurationSeconds: 300
  });
  const topic = {
    id: "TOPIC_01",
    title: "跪地母亲",
    relationship: "母女",
    logline: "女儿误解跪地缝婚纱的母亲，证据最终揭开牺牲。",
    hook: "女儿踢开跪地缝纫的母亲，婚纱裙摆从她手里滑落。",
    proofChain: "手术单日期、婚纱血渍和邻居证言形成证据链。",
    reversal: "女儿确认母亲为婚礼错过治疗并公开承担错误。",
    emotionalPayoff: "女儿用持续行动照顾母亲。"
  };
  store.patchProject(created.id, {
    productionPlan: { inputMode: "ai", executionMode: "step", scriptFormat: "dialogue", scriptFormatConfirmed: true },
    generation: { targetDurationSeconds: 300, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "smart", modeConfirmed: true },
    product: { name: "硅胶护膝", description: "日常活动支撑", sellingPoints: "贴合膝部、活动支撑", imagePath },
    ideation: { topics: [topic], selectedTopicId: topic.id, status: "ready" }
  });
  const calls = new Map();
  let failMiddle = true;
  const ranges = directFastSegmentRanges(30);
  const schedule = planFilmSchedule(300, "puream-hailuo-h3", { preferredUnit: 10, engine: "hailuo-h3" });
  const workflow = new (require("../app/workbench-workflow").WorkbenchWorkflow)({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages) => {
      const user = String(messages.find(message => message.role === "user")?.content || "");
      if (/全剧骨架/.test(user)) return compactStorySpine(ranges);
      const range = user.match(/第(\d+)-(\d+)镜/);
      const start = Number(range?.[1]);
      const end = Number(range?.[2]);
      calls.set(start, (calls.get(start) || 0) + 1);
      if (start === 11 && failMiddle) {
        failMiddle = false;
        throw Object.assign(new Error("模拟连接中断"), { code: "PUREAM_TEXT_STREAM_ERROR", noAutomaticRetry: true });
      }
      return { s: strictSegmentPayload(start, end, schedule.suggestedDurations).s };
    }
  });

  const completed = await workflow.generateCompleteScript(created.id);
  assert.equal(calls.get(11), 1, "invalid upstream output must not trigger a second billable request");
  for (const start of [1, 6, 16, 21, 26]) assert.equal(calls.get(start), 1, `completed segment S${start} must be reused`);
  assert.equal(completed.script.generationCheckpoint, null);
  assert.equal(completed.shots.length, 30);
  assert.equal(completed.currentStage, "assets");
  assert.equal(completed.script.generationPerformance.localFallbackCount, 1);
  assert.deepEqual(completed.script.generationPerformance.localFallbackRanges, [[11, 15]]);
  assert.deepEqual(completed.script.generationPerformance.generationSources, ["agent", "deterministic-local-preservation"]);
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
