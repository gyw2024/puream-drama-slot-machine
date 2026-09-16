"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FIXED_SFX_LIBRARY_VERSION = "2026.09-fixed-sfx-150-v1";
const SOURCE_REPOSITORY = "https://github.com/lavenderdotpet/CC0-Public-Domain-Sounds";
const SOURCE_RAW_BASE = "https://raw.githubusercontent.com/lavenderdotpet/CC0-Public-Domain-Sounds/main";

function numberedPaths(prefix, stem, count, extension = "ogg", start = 0, pad = 3) {
  return Array.from({ length: count }, (_item, index) => `${prefix}/${stem}${String(start + index).padStart(pad, "0")}.${extension}`);
}

function simpleNumberedPaths(prefix, stem, count, extension = "ogg", start = 1, pad = 2) {
  return Array.from({ length: count }, (_item, index) => `${prefix}/${stem}${String(start + index).padStart(pad, "0")}.${extension}`);
}

const SERIES = Object.freeze([
  { category: "emphasis", role: "accent", name: "咚咚剧情强调", paths: numberedPaths("kenney_impactsounds/Audio", "impactBell_heavy_", 5), tags: ["咚咚", "强调", "身份揭晓", "反转", "落锤", "权势登场"], gainDb: -13, pattern: "double" },
  { category: "emphasis", role: "accent", name: "隆重锣点", paths: simpleNumberedPaths("100-CC0-SFX", "gong_", 2), tags: ["隆重", "宣布", "舞台", "揭晓", "打脸"], gainDb: -15 },
  { category: "emphasis", role: "accent", name: "清亮揭晓", paths: simpleNumberedPaths("100-CC0-SFX", "bell_", 3), tags: ["揭晓", "成功", "证据", "产品亮相", "好消息"], gainDb: -17 },
  { category: "emphasis", role: "accent", name: "沉重单咚", paths: ["kenney_interfacesounds/Audio/bong_001.ogg"], tags: ["沉重", "坏消息", "压迫", "震惊", "冷场"], gainDb: -14 },
  { category: "emphasis", role: "accent", name: "结果确认", paths: numberedPaths("kenney_interfacesounds/Audio", "confirmation_", 4, "ogg", 1), tags: ["确认", "通过", "到账", "名单", "决定"], gainDb: -18 },
  { category: "emphasis", role: "accent", name: "轻型剧情落点", paths: numberedPaths("kenney_impactsounds/Audio", "impactGeneric_light_", 5), tags: ["轻强调", "眼神", "特写", "证据", "停顿"], gainDb: -17 },

  { category: "comedy", role: "accent", name: "弹簧滑稽", paths: simpleNumberedPaths("100-CC0-SFX", "spring_", 9), tags: ["弹簧", "搞笑", "狼狈", "落荒而逃", "尴尬", "无语"], gainDb: -17 },
  { category: "comedy", role: "accent", name: "疑惑问号", paths: numberedPaths("kenney_interfacesounds/Audio", "question_", 4, "ogg", 1), tags: ["疑惑", "愣住", "听不懂", "反问", "问号"], gainDb: -18 },
  { category: "comedy", role: "accent", name: "Q弹冒泡", paths: simpleNumberedPaths("100-CC0-SFX", "plop_", 2), tags: ["Q弹", "冒泡", "滑稽", "小尴尬"], gainDb: -18 },
  { category: "comedy", role: "accent", name: "翻车失败", paths: numberedPaths("kenney_interfacesounds/Audio", "error_", 5, "ogg", 1), tags: ["翻车", "失败", "被拒", "出丑", "搞笑"], gainDb: -18 },

  { category: "transition", role: "transition", name: "快速唰声", paths: simpleNumberedPaths("Micro Pack - Organic Wooshes", "Swish ", 6, "wav", 1, 1), tags: ["唰", "转场", "甩镜", "快速转头", "证据甩出"], gainDb: -19 },
  { category: "transition", role: "transition", name: "经典呼啸", paths: simpleNumberedPaths("Micro Pack - Organic Wooshes", "Classic Swish ", 3, "wav", 1, 1), tags: ["呼啸", "转场", "人物登场", "推进"], gainDb: -18 },
  { category: "transition", role: "transition", name: "组合转场", paths: simpleNumberedPaths("Micro Pack - Organic Wooshes", "Combo ", 4, "wav", 1, 1), tags: ["强转场", "反转", "身份出现", "闪回"], gainDb: -18 },
  { category: "transition", role: "transition", name: "旋转转场", paths: simpleNumberedPaths("Micro Pack - Organic Wooshes", "Twirl ", 4, "wav", 1, 1), tags: ["旋转", "舞蹈", "回忆", "镜头环绕"], gainDb: -20 },
  { category: "transition", role: "transition", name: "重落转场", paths: simpleNumberedPaths("Micro Pack - Organic Wooshes", "Thunk ", 2, "wav", 1, 1), tags: ["重落点", "冲突", "切近景", "打断"], gainDb: -16 },
  { category: "transition", role: "transition", name: "刀锋划过", paths: ["Micro Pack - Organic Wooshes/Slash.wav"], tags: ["锋利", "决裂", "警告", "快速划过"], gainDb: -18 },

  { category: "suspense", role: "accent", name: "悬疑异响", paths: simpleNumberedPaths("30-cc0-weird-sfx", "weird_", 15), tags: ["悬疑", "秘密", "偷听", "危险", "怀疑", "紧张", "真相逼近"], gainDb: -21 },

  { category: "action", role: "foley", name: "重拳踹击", paths: numberedPaths("kenney_impactsounds/Audio", "impactPunch_heavy_", 5), tags: ["重拳", "踹开", "殴打", "身体重击"], gainDb: -10 },
  { category: "action", role: "foley", name: "耳光推搡", paths: numberedPaths("kenney_impactsounds/Audio", "impactPunch_medium_", 5), tags: ["耳光", "扇巴掌", "推搡", "轻拳", "抓扯"], gainDb: -12 },
  { category: "action", role: "foley", name: "倒地跪地", paths: numberedPaths("kenney_impactsounds/Audio", "impactSoft_heavy_", 5), tags: ["倒地", "跪下", "摔倒", "身体触地"], gainDb: -14 },
  { category: "action", role: "foley", name: "拍桌砸物", paths: simpleNumberedPaths("75-cc0-breaking-falling-hit-sfx", "bfh1_hit_", 5), tags: ["拍桌", "砸物", "碰撞", "怒拍", "落地"], gainDb: -12 },
  { category: "action", role: "foley", name: "玻璃破碎", paths: simpleNumberedPaths("75-cc0-breaking-falling-hit-sfx", "bfh1_glass_breaking_", 3), tags: ["玻璃破碎", "摔杯", "镜子碎裂"], gainDb: -13 },
  { category: "action", role: "foley", name: "木物倒下", paths: simpleNumberedPaths("100-CC0-wood-metal-SFX", "wood_falling_", 2), tags: ["椅子倒", "木盒落地", "木物跌落"], gainDb: -15 },

  { category: "life", role: "foley", name: "房门打开", paths: simpleNumberedPaths("kenney_rpgaudio/Audio", "doorOpen_", 2, "ogg", 1, 1), tags: ["开门", "推门", "进入", "闯入"], gainDb: -17 },
  { category: "life", role: "foley", name: "房门关闭", paths: simpleNumberedPaths("kenney_rpgaudio/Audio", "doorClose_", 4, "ogg", 1, 1), tags: ["关门", "摔门", "离开", "密谈"], gainDb: -16 },
  { category: "life", role: "foley", name: "门锁动作", paths: ["100-CC0-SFX/door_open.ogg", "100-CC0-SFX/door_close_01.ogg"], tags: ["门锁", "门把手", "开锁", "反锁"], gainDb: -18 },
  { category: "life", role: "foley", name: "纸张文件", paths: simpleNumberedPaths("100-CC0-SFX", "paper_", 4), tags: ["纸张", "合同", "文件", "名单", "证据", "甩桌"], gainDb: -19 },
  { category: "life", role: "foley", name: "翻书翻页", paths: ["kenney_rpgaudio/Audio/bookFlip1.ogg", "kenney_rpgaudio/Audio/bookFlip2.ogg", "kenney_rpgaudio/Audio/bookFlip3.ogg", "kenney_rpgaudio/Audio/bookOpen.ogg", "kenney_rpgaudio/Audio/bookClose.ogg", "kenney_rpgaudio/Audio/bookPlace1.ogg"], tags: ["翻页", "打开文件", "合上文件", "书本", "报告"], gainDb: -20 },
  { category: "life", role: "foley", name: "杯碟轻碰", paths: simpleNumberedPaths("100-CC0-SFX", "dishes_", 2), tags: ["杯子", "酒杯", "茶杯", "餐具", "碰杯"], gainDb: -19 },

  { category: "footsteps", role: "foley", name: "硬地脚步", paths: numberedPaths("kenney_impactsounds/Audio", "footstep_concrete_", 5), tags: ["脚步", "走来", "靠近", "奔跑", "入场", "硬地"], gainDb: -20 },
  { category: "footsteps", role: "foley", name: "地毯脚步", paths: numberedPaths("kenney_impactsounds/Audio", "footstep_carpet_", 4), tags: ["脚步", "酒店", "会场", "办公室", "地毯"], gainDb: -22 },
  { category: "footsteps", role: "foley", name: "木地板脚步", paths: numberedPaths("kenney_impactsounds/Audio", "footstep_wood_", 3), tags: ["脚步", "老宅", "卧室", "舞厅", "木地板"], gainDb: -20 },
  { category: "footsteps", role: "foley", name: "衣料动作", paths: simpleNumberedPaths("kenney_rpgaudio/Audio", "cloth", 3, "ogg", 1, 1), tags: ["衣料", "转身", "拥抱", "拉扯", "起身"], gainDb: -22 },

  { category: "environment", role: "ambience", name: "雨夜环境", paths: ["30-cc0-sfx-loops/rain.ogg", "40-cc0-water-splash-slime-sfx/loop_rain.ogg"], tags: ["雨", "暴雨", "雨夜", "门外风雨"], gainDb: -30, loop: true },
  { category: "environment", role: "ambience", name: "流水环境", paths: ["30-cc0-sfx-loops/water_flowing.ogg"], tags: ["流水", "水景", "倒水", "庭院"], gainDb: -31, loop: true },
  { category: "environment", role: "ambience", name: "室内低环境", paths: simpleNumberedPaths("100-cc0-sfx-2", "sfx100v2_loop_ambient_", 4), tags: ["室内", "办公室", "家中", "会场", "酒店", "酒吧", "医院"], gainDb: -34, loop: true },
  { category: "environment", role: "ambience", name: "道路车辆环境", paths: ["100-cc0-sfx-2/sfx100v2_loop_highway.ogg"], tags: ["道路", "汽车", "车内", "街道", "交通"], gainDb: -32, loop: true },

  { category: "technology", role: "foley", name: "手机消息提示", paths: numberedPaths("kenney_interfacesounds/Audio", "click_", 3, "ogg", 1), tags: ["手机", "消息", "提示", "点击", "通知"], gainDb: -20 },
  { category: "technology", role: "foley", name: "开关按钮", paths: numberedPaths("kenney_interfacesounds/Audio", "switch_", 2, "ogg", 1), tags: ["开关", "按钮", "设备", "开灯", "关灯"], gainDb: -20 },
  { category: "technology", role: "foley", name: "包装开合", paths: ["kenney_rpgaudio/Audio/metalClick.ogg"], tags: ["开盖", "旋盖", "包装", "盒盖", "产品"], gainDb: -20 },
  { category: "technology", role: "foley", name: "金钱到账", paths: ["kenney_rpgaudio/Audio/handleCoins.ogg"], tags: ["付款", "到账", "金钱", "交易", "购买"], gainDb: -21 }
]);

function buildSourceCatalog() {
  const result = [];
  let index = 0;
  for (const series of SERIES) {
    series.paths.forEach((sourcePath, variantIndex) => {
      index += 1;
      result.push(Object.freeze({
        id: `SFX-${String(index).padStart(3, "0")}`,
        category: series.category,
        role: series.role,
        displayName: `${series.name}${series.paths.length > 1 ? ` ${variantIndex + 1}` : ""}`,
        tags: [...series.tags],
        gainDb: Number(series.gainDb) || -18,
        loop: series.loop === true,
        pattern: series.pattern || "single",
        sourcePath,
        sourceUrl: `${SOURCE_RAW_BASE}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
        sourceRepository: SOURCE_REPOSITORY,
        license: "CC0-1.0",
        fileName: `SFX-${String(index).padStart(3, "0")}.ogg`
      }));
    });
  }
  return result;
}

const BUILTIN_SFX_CATALOG = Object.freeze(buildSourceCatalog());

function defaultLibraryRoot() {
  // External FFmpeg cannot open files through Electron's virtual app.asar
  // filesystem. Packaged builds therefore ship this library as a real
  // extraResource and runtime resolution prefers that physical directory.
  const packagedRoot = process.resourcesPath ? path.join(process.resourcesPath, "builtin-sfx") : "";
  if (packagedRoot && fs.existsSync(path.join(packagedRoot, "catalog.json"))) return packagedRoot;
  return path.join(__dirname, "assets", "builtin-sfx");
}

function catalogWithFiles(root = defaultLibraryRoot()) {
  return BUILTIN_SFX_CATALOG.map(item => ({ ...item, filePath: path.join(root, "audio", item.fileName) }));
}

function validateBuiltinSfxCatalog(catalog = catalogWithFiles(), options = {}) {
  const failures = [];
  if (catalog.length !== 150) failures.push(`catalog must contain exactly 150 effects, received ${catalog.length}`);
  const ids = new Set();
  const files = new Set();
  for (const item of catalog) {
    if (!/^SFX-\d{3}$/.test(String(item?.id || ""))) failures.push(`invalid id: ${item?.id || "missing"}`);
    if (ids.has(item.id)) failures.push(`duplicate id: ${item.id}`);
    ids.add(item.id);
    if (!String(item?.displayName || "").trim()) failures.push(`${item.id} has no displayName`);
    if (!Array.isArray(item?.tags) || item.tags.length < 2) failures.push(`${item.id} has insufficient semantic tags`);
    if (!item?.filePath) failures.push(`${item.id} has no filePath`);
    if (files.has(item?.filePath)) failures.push(`${item.id} duplicates a packaged file path`);
    files.add(item?.filePath);
    if (options.requireFiles === true && (!fs.existsSync(item.filePath) || fs.statSync(item.filePath).size <= 0)) failures.push(`${item.id} audio file is missing`);
  }
  return { ok: failures.length === 0, failures, count: catalog.length, version: FIXED_SFX_LIBRARY_VERSION };
}

function hashIndex(value, count) {
  if (!count) return 0;
  const digest = crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
  return digest.readUInt32BE(0) % count;
}

function compactShotText(shot = {}, scene = {}) {
  const fields = [
    shot.title, shot.action, shot.visualBeat, shot.stateBefore, shot.stateAfter,
    shot.causalLink, shot.audioPlan, shot.soundDesign, shot.emotion, shot.mainlineStage,
    shot.mainlineBeat, shot.transitionReason, shot.productShotType, scene.name,
    scene.description, scene.interiorExterior
  ];
  for (const turn of Array.isArray(shot.dialogueTurns) ? shot.dialogueTurns : []) {
    fields.push(turn.text, turn.intent, turn.emotionStart, turn.emotionPeak, turn.body, turn.listenerBeat);
  }
  for (const subshot of Array.isArray(shot.subshots) ? shot.subshots : []) {
    fields.push(subshot.action, subshot.visual, subshot.sound, subshot.transition);
  }
  return fields.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const MATCH_RULES = Object.freeze([
  { id: "slap", regex: /耳光|扇(?:了|向|他|她)?(?:一)?巴掌|掌掴|打脸/, category: "action", prefer: ["耳光", "扇巴掌"], anchor: "middle", reason: "明确扇耳光动作" },
  { id: "punch", regex: /拳打|重拳|殴打|踹(?:开|倒|飞|向)|一脚踢/, category: "action", prefer: ["重拳", "踹开"], anchor: "middle", reason: "明确拳脚冲击动作" },
  { id: "kneel", regex: /跪下|下跪|双膝跪地|跪地求/, category: "action", prefer: ["跪下", "身体触地"], anchor: "end", reason: "双膝触地动作" },
  { id: "fall", regex: /摔倒|倒地|跌倒|瘫倒|被推倒/, category: "action", prefer: ["倒地", "摔倒"], anchor: "end", reason: "人物倒地动作" },
  { id: "glass_break", regex: /玻璃(?:杯|门|窗|镜)?(?:破|碎|摔碎)|摔杯/, category: "action", prefer: ["玻璃破碎", "摔杯"], anchor: "end", reason: "玻璃明确破碎" },
  { id: "table", regex: /拍桌|砸桌|重重放下|甩在桌|摔在桌/, category: "action", prefer: ["拍桌", "怒拍"], anchor: "middle", reason: "桌面撞击动作" },
  { id: "door", regex: /推门|开门|关门|摔门|闯入|破门而入/, category: "life", prefer: ["开门", "关门", "摔门", "闯入"], anchor: "start", reason: "门体动作或人物入场铺垫" },
  { id: "paper", regex: /合同|文件|名单|报告|证据|邀请函|递出.*纸|撕纸|翻页/, category: "life", prefer: ["合同", "文件", "证据", "纸张"], anchor: "middle", reason: "文件或证据发生可见操作" },
  { id: "cup", regex: /酒杯|茶杯|杯子|碰杯|放下.*杯|端起.*杯/, category: "life", prefer: ["杯子", "酒杯", "茶杯"], anchor: "middle", reason: "杯具可见接触" },
  { id: "footstep", regex: /走来|走近|走进|入场|赶来|冲进|跑来|上楼|下楼|脚步/, category: "footsteps", prefer: ["脚步", "走来", "入场"], anchor: "start", reason: "人物移动和出场铺垫" },
  { id: "cloth", regex: /转身|拥抱|拉扯|抓住衣|揪住|猛地起身/, category: "footsteps", prefer: ["衣料", "转身", "拉扯"], anchor: "middle", reason: "衣料或身体动作" },
  { id: "phone", regex: /手机|来电|消息|短信|通知|电话响|屏幕亮/, category: "technology", prefer: ["手机", "消息", "提示"], anchor: "middle", reason: "手机或消息事件" },
  { id: "product", regex: /产品|商品|包装|开盖|旋盖|挤出|倒出|拿出.*盒|点击左下角|橱窗购买/, category: "technology", prefer: ["包装", "产品", "开盖", "购买"], anchor: "middle", reason: "产品真实操作或购买动作" },
  { id: "money", regex: /付款|到账|转账|价格|购买|内购|订单/, category: "technology", prefer: ["付款", "到账", "金钱", "购买"], anchor: "end", reason: "交易结果或购买决定" },
  { id: "comedy", regex: /搞笑|滑稽|狼狈|落荒而逃|尴尬|无语|出丑|翻车|嫌弃|白眼/, category: "comedy", prefer: ["搞笑", "狼狈", "尴尬", "无语", "翻车"], anchor: "end", reason: "喜剧反应或尴尬落点" },
  { id: "question", regex: /疑惑|愣住|没听懂|一脸问号|反问|懵了/, category: "comedy", prefer: ["疑惑", "愣住", "问号"], anchor: "end", reason: "疑惑反应" },
  { id: "suspense", regex: /悬疑|秘密|偷听|危险|怀疑|紧张|真相逼近|幕后|阴谋|监控/, category: "suspense", prefer: ["悬疑", "秘密", "危险", "真相逼近"], anchor: "middle", reason: "悬疑或危险氛围" },
  { id: "reveal", regex: /身份揭晓|公布|真相|原来|竟然|老板复出|董事长|大佬|君临天下|全场震惊|反转|打脸/, category: "emphasis", prefer: ["咚咚", "身份揭晓", "反转", "权势登场"], anchor: "end", reason: "身份、真相或权力反转落点" },
  { id: "success", regex: /成功|通过|确认|获准|名单公布|资格恢复|合作达成/, category: "emphasis", prefer: ["确认", "通过", "成功"], anchor: "end", reason: "明确成功结果" },
  { id: "transition", regex: /闪回|回忆|转场|镜头甩|快速转头|猛然回头|画面切换/, category: "transition", prefer: ["转场", "闪回", "快速转头"], anchor: "middle", reason: "有动机的镜头或时间转换" }
]);

function chooseCatalogItem(catalog, rule, seed, excludedIds = new Set()) {
  let candidates = catalog.filter(item => item.category === rule.category && !excludedIds.has(item.id));
  const preferred = candidates.filter(item => rule.prefer.some(tag => item.tags.includes(tag)));
  if (preferred.length) candidates = preferred;
  if (!candidates.length) return null;
  return candidates[hashIndex(seed, candidates.length)];
}

function localCueTime(shot, rule) {
  const duration = Math.max(0.5, Number(shot?.duration) || 10);
  const matchingSubshot = (Array.isArray(shot?.subshots) ? shot.subshots : []).find(item => rule.regex.test([item.action, item.visual, item.sound, item.transition].filter(Boolean).join(" ")));
  if (matchingSubshot) {
    const start = Math.max(0, Number(matchingSubshot.start) || 0);
    const end = Math.min(duration, Math.max(start, Number(matchingSubshot.end) || duration));
    const ratio = rule.anchor === "start" ? 0.12 : rule.anchor === "end" ? 0.82 : 0.5;
    return Math.max(0.28, Math.min(duration - 0.12, start + ((end - start) * ratio)));
  }
  if (rule.anchor === "start") return Math.max(0.28, Math.min(duration - 0.12, duration * 0.12));
  if (rule.anchor === "end") return Math.max(0.28, duration - 0.45);
  return Math.max(0.28, Math.min(duration - 0.12, duration * 0.55));
}

function environmentRule(text) {
  if (/雨|暴雨|雨夜/.test(text)) return { prefer: ["雨", "雨夜"], reason: "画面或剧本明确为雨天环境" };
  if (/道路|汽车|车内|街道|公路|停车场/.test(text)) return { prefer: ["道路", "汽车", "车内"], reason: "道路或车辆环境" };
  if (/流水|水景|河边|池塘|倒水/.test(text)) return { prefer: ["流水", "水景"], reason: "水体或倒水环境" };
  if (/室内|办公室|家中|客厅|卧室|会场|酒店|酒吧|医院|会议室|宴会/.test(text)) return { prefer: ["室内", "办公室", "会场", "酒店", "酒吧", "医院"], reason: "明确室内场景的低存在感环境声" };
  return null;
}

function buildFixedSfxPlan(project = {}, options = {}) {
  const catalog = options.catalog || catalogWithFiles(options.libraryRoot || defaultLibraryRoot());
  const orderedShots = (Array.isArray(project?.shots) ? project.shots : []).slice().sort((a, b) => Number(a.number) - Number(b.number));
  const scenesById = new Map((Array.isArray(project?.scenes) ? project.scenes : []).map(item => [String(item.id), item]));
  const shots = [];
  const recentIds = [];
  let programmeOffset = 0;
  for (const shot of orderedShots) {
    const duration = Math.max(0.5, Number(shot.duration) || 10);
    const scene = scenesById.get(String(shot.sceneId || "")) || {};
    const text = compactShotText(shot, scene);
    const cues = [];
    const excluded = new Set(recentIds.slice(-6));
    const environment = environmentRule(text);
    if (environment) {
      const rule = { category: "environment", prefer: environment.prefer };
      const item = chooseCatalogItem(catalog, rule, `${project.id}|${shot.id}|environment`, excluded);
      if (item) {
        cues.push({
          id: `${shot.id || shot.number}-ambience`,
          effectId: item.id,
          role: "ambience",
          localTimeSeconds: 0.28,
          programmeTimeSeconds: Number((programmeOffset + 0.28).toFixed(3)),
          durationSeconds: Number(Math.max(0.1, duration - 0.28).toFixed(3)),
          loop: true,
          gainDb: item.gainDb,
          fadeInSeconds: 0.16,
          fadeOutSeconds: 0.22,
          reason: environment.reason
        });
        excluded.add(item.id);
      }
    }
    const matchedRules = MATCH_RULES.filter(rule => rule.regex.test(text));
    const selectedRules = [];
    const addRule = rule => {
      if (!rule || selectedRules.some(item => item.id === rule.id)) return;
      selectedRules.push(rule);
    };
    addRule(matchedRules.find(rule => rule.category === "action" || rule.category === "life" || rule.category === "footsteps" || rule.category === "technology"));
    addRule(matchedRules.find(rule => ["emphasis", "comedy", "suspense", "transition"].includes(rule.category)));
    for (const rule of selectedRules.slice(0, 2)) {
      const item = chooseCatalogItem(catalog, rule, `${project.id}|${shot.id}|${rule.id}`, excluded);
      if (!item) continue;
      const localTimeSeconds = localCueTime(shot, rule);
      cues.push({
        id: `${shot.id || shot.number}-${rule.id}`,
        effectId: item.id,
        role: item.role,
        localTimeSeconds: Number(localTimeSeconds.toFixed(3)),
        programmeTimeSeconds: Number((programmeOffset + localTimeSeconds).toFixed(3)),
        durationSeconds: 0,
        loop: false,
        gainDb: item.gainDb,
        fadeInSeconds: 0.01,
        fadeOutSeconds: 0.06,
        reason: rule.reason
      });
      excluded.add(item.id);
    }
    for (const cue of cues) recentIds.push(cue.effectId);
    shots.push({
      shotId: shot.id,
      shotNumber: shot.number,
      durationSeconds: duration,
      programmeOffsetSeconds: Number(programmeOffset.toFixed(3)),
      cues
    });
    programmeOffset += duration;
  }
  const cueCount = shots.reduce((sum, item) => sum + item.cues.length, 0);
  return {
    version: "1.0",
    libraryVersion: FIXED_SFX_LIBRARY_VERSION,
    createdAt: new Date().toISOString(),
    source: "adaptive-agent-fixed-library-match",
    generatedAudio: false,
    catalogSize: catalog.length,
    programmeDurationSeconds: Number(programmeOffset.toFixed(3)),
    cueCount,
    shots
  };
}

function validateFixedSfxPlan(plan = {}, catalog = catalogWithFiles(), options = {}) {
  const failures = [];
  const catalogAudit = validateBuiltinSfxCatalog(catalog, { requireFiles: options.requireFiles === true });
  failures.push(...catalogAudit.failures);
  const knownIds = new Set(catalog.map(item => item.id));
  for (const shot of Array.isArray(plan?.shots) ? plan.shots : []) {
    if ((shot.cues || []).length > 3) failures.push(`S${shot.shotNumber} has more than 3 post-production cues`);
    for (const cue of Array.isArray(shot.cues) ? shot.cues : []) {
      if (!knownIds.has(cue.effectId)) failures.push(`S${shot.shotNumber} references unknown effect ${cue.effectId}`);
      if (!(Number(cue.localTimeSeconds) >= 0.25)) failures.push(`S${shot.shotNumber} cue ${cue.effectId} is inside the protected head interval`);
      if (!String(cue.reason || "").trim()) failures.push(`S${shot.shotNumber} cue ${cue.effectId} has no explainable reason`);
    }
  }
  return { ok: failures.length === 0, failures, catalog: catalogAudit, cueCount: Number(plan?.cueCount) || 0 };
}

module.exports = {
  BUILTIN_SFX_CATALOG,
  FIXED_SFX_LIBRARY_VERSION,
  SOURCE_REPOSITORY,
  buildFixedSfxPlan,
  catalogWithFiles,
  compactShotText,
  defaultLibraryRoot,
  validateBuiltinSfxCatalog,
  validateFixedSfxPlan
};
