"use strict";

const crypto = require("node:crypto");
const { fingerprint } = require("./canonical");

const RELATIONSHIPS = ["母女", "父子", "婆媳", "兄妹", "姐妹", "祖孙", "老夫妻", "邻里", "师徒", "继母继女", "姑嫂", "老同事", "雇佣关系", "妯娌", "父女", "兄弟"];
const OBJECTS = ["药费单", "旧钥匙", "录取信", "工钱袋", "房本封皮", "保温箱", "水费单", "录音笔", "手术单", "布鞋", "旧雨伞", "银手镯", "签到册", "修理票", "老照片", "借条", "饭盒", "结算本", "检查报告", "仓库钥匙"];
const CRISES = [
  ["当众被赶出家门", "把行李摔到雨里"],
  ["在调解室被指认吞钱", "将银行卡拍在桌上"],
  ["在病房门口被拦下", "把签字笔夺走"],
  ["在婚宴门口被推倒", "让她当众交出存折"],
  ["在楼道里被锁在门外", "把旧家具堆到她脚边"],
  ["在社区门口被搜包", "当众指认她拿了赔偿款"],
  ["在直播间被否认身份", "将她保留多年的物件扔出镜头"],
  ["在车站被逼着放弃继承", "把已签的协议撕成两半"]
];
const MECHANISMS = [
  ["evidence_chain", "日期、流水和见证人前后互证", "侵占者归还钱款并签下分期协议"],
  ["promise_return", "旧承诺、门禁时间和当年的受助者同时回归", "受助者公开澄清并承担后续照护"],
  ["identity_proof", "受损物件、编号底档和保管记录锁定真正责任人", "造假者失去处置权并当场撤回指控"],
  ["sacrifice_repaid", "收据、工伤记录与旁人证言还原多年牺牲", "被蒙蔽的家人公开归还利益并建立新边界"],
  ["rescue_repaid", "急救回执、监控时间和受救者的当面证言形成闭环", "受救者阻止驱赶并完成实际赔偿"],
  ["motive_reveal", "重复出现的小动作、利益流向和一句被忽略的承诺揭开动机", "受益人失去不当利益并向受害者补偿"]
];
const PLACES = ["雨棚下", "调解室里", "病房门外", "老屋门口", "公交站边", "社区公告栏前", "仓库门口", "婚宴楼下", "康复中心里", "菜场后门"];

function seededRandom(seedValue) {
  let state = Number.parseInt(crypto.createHash("sha256").update(String(seedValue)).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

function normalizeTitle(value = "") {
  return String(value || "").replace(/[\s··《》：:,.，。!?！？'"“”‘’]/g, "").toLowerCase();
}

function topicSignature(topic = {}) {
  return fingerprint({ title: normalizeTitle(topic.title), relationship: topic.relationship, mechanism: topic.storyMechanism, hook: topic.hook, object: topic.themeObject });
}

function topicHistory(project = {}) {
  return Array.isArray(project.ideation?.topicHistory) ? project.ideation.topicHistory : [];
}

function makeTitle(objectName, place, crisis, variant) {
  const templates = [
    () => `${place}的${objectName}`,
    () => `被扔出去的${objectName}`,
    () => `${objectName}里藏着的日期`,
    () => `门外那份${objectName}`,
    () => `没有签字的${objectName}`,
    () => `${crisis.slice(0, 7)}后的${objectName}`,
    () => `第二个名字与${objectName}`,
    () => `${objectName}上的旧折痕`
  ];
  return templates[variant % templates.length]().replace(/里的的/g, "里的");
}

function createTopic({ relationship, objectName, crisis, mechanism, place, variant, productName }) {
  const [crisisState, crisisAction] = crisis;
  const [storyMechanism, proofChain, resolution] = mechanism;
  const title = makeTitle(objectName, place, crisisState, variant);
  return {
    title,
    genre: "写实家庭伦理",
    relationship,
    storyMechanism,
    logline: `${relationship}关系中，善良者${crisisState}，她不再忍让，而是沿${objectName}的真实来源查清利益链，让伤害者付出可见代价`,
    hook: `${crisisAction}；她立刻护住${objectName}，却因此失去一条退路`,
    highlights: ["危机动作直接入戏", "中段每次反应带来新代价", "反转线索前置互证", "结局用行动完成清算"],
    valueStatement: "善意不是默认忍受，真相必须带来实际的边界与补偿",
    protagonistWound: `${relationship}中的一次具体牺牲长期未被看见`,
    falseBelief: "只要一直退让，关系就会自然变好",
    themeObject: objectName,
    proofChain,
    reversal: resolution,
    emotionalPayoff: "受害者不靠身份突变翻身，而靠前置行动和完整因果拿回主动权",
    productPlacement: productName ? `${productName}只在人物解决一个真实生活问题时自然出现，不面向镜头导购` : "当前无商品约束，故事必须独立成立",
    audienceAppeal: "开场心疼、中段愤怒、后段以可见证据和行动清算释放情绪",
    reason: "人物关系、危机动作、反转证据、现实代价和行动结局均可视化"
  };
}

function buildNovelTopicBatch(project = {}, generationIndex = 1, options = {}) {
  const history = topicHistory(project);
  const usedTitles = new Set(history.map(item => normalizeTitle(item.title)).filter(Boolean));
  const usedSignatures = new Set(history.map(item => String(item.signature || "")).filter(Boolean));
  const nonce = String(options.nonce || crypto.randomUUID());
  const random = seededRandom(`${project.id}|${generationIndex}|${nonce}`);
  const productName = String(project.product?.name || "").trim();
  const topics = [];
  for (let attempt = 0; topics.length < 10 && attempt < 2_000; attempt += 1) {
    const topic = createTopic({
      relationship: pick(RELATIONSHIPS, random),
      objectName: pick(OBJECTS, random),
      crisis: pick(CRISES, random),
      mechanism: pick(MECHANISMS, random),
      place: pick(PLACES, random),
      variant: Math.floor(random() * 10_000) + attempt,
      productName
    });
    const signature = topicSignature(topic);
    const titleKey = normalizeTitle(topic.title);
    if (usedTitles.has(titleKey) || usedSignatures.has(signature) || topics.some(item => normalizeTitle(item.title) === titleKey || topicSignature(item) === signature)) continue;
    topics.push(topic);
  }
  if (topics.length !== 10) throw Object.assign(new Error("本地选题组合空间异常，未能产生 10 个全新选题"), { code: "TOPIC_DIVERSITY_EXHAUSTED" });
  return { topics, nonce };
}

function rememberTopicBatch(project = {}, topics = [], source = "upstream") {
  const current = topicHistory(project);
  const at = new Date().toISOString();
  const additions = topics.map(topic => ({ title: String(topic.title || ""), signature: topicSignature(topic), relationship: String(topic.relationship || ""), source, generatedAt: at }));
  const bySignature = new Map();
  for (const entry of [...additions, ...current]) {
    const key = String(entry.signature || fingerprint({ title: normalizeTitle(entry.title), relationship: entry.relationship }));
    if (!bySignature.has(key)) bySignature.set(key, { ...entry, signature: key });
  }
  project.ideation = { ...(project.ideation || {}), topicHistory: [...bySignature.values()].slice(0, 500) };
  return project.ideation.topicHistory;
}

function priorTopicTitles(project = {}, limit = 80) {
  return topicHistory(project).map(item => String(item.title || "").trim()).filter(Boolean).slice(0, Math.max(1, limit));
}

module.exports = { buildNovelTopicBatch, normalizeTitle, priorTopicTitles, rememberTopicBatch, topicHistory, topicSignature };
