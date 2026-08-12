"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { materializeDirectFastScript } = require("../app/direct-fast-script");
const { planFilmSchedule } = require("../app/duration-contract");
const { allocateH3ShotSpeakers, h3AllowedSpeakersByShot } = require("../app/h3-speaker-allocation");
const {
  auditDramaSpec,
  normalizeAnalysis,
  validateBlueprint,
  validateShotBatch,
  validateStoryBible
} = require("../app/workbench-workflow");

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
  const materialized = materializeDirectFastScript({ payload, topic, product, filmSchedule });
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
