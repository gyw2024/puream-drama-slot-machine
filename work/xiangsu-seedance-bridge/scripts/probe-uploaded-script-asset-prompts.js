"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  fillTemplate,
  parseTimedStoryboardScript,
  parseStructuredProductionScript
} = require("../app/workbench-workflow");
const { detectUploadedScriptFormat: detectFormat, parseSourceDialogueLedger: parseLedger } = require("../app/dialogue-parser");
const { buildSourceSceneLedger } = require("../app/script-scene-ledger");
const { estimateUploadedScriptDuration } = require("../app/script-duration");

const OUTPUT_ROOT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260817-SCRIPT-ASSET-PROMPT-PROBE");
const FORBIDDEN = /字幕|标题|姓名条|价格字|水印|背景音乐|BGM|人物介绍|故事简介|面向镜头/;

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function buildDialogueScript() {
  const lines = [
    ["【场景】老小区客厅", ""],
    ["周宁", "摔门进来，压着火", "妈，房产证呢？"],
    ["周桂兰", "手里攥着茶盏，发颤", "你回来也不先坐下。"],
    ["周宁", "提高音量", "别绕。中介说你把证拿出去了。"],
    ["周桂兰", "低头，声音发虚", "我没卖房子。"],
    ["周宁", "把手机屏幕怼过去", "那这张委托书是谁签的？"],
    ["周桂兰", "愣住", "那是……给你弟看病用的。"],
    ["周宁", "冷笑", "周凯又把你当提款机了。"],
    ["周桂兰", "急促", "他不是故意的。"],
    ["周宁", "一字一顿", "三十年了，你每次都这么说。"],
    ["周桂兰", "哽咽", "他要是挺不过去，我怎么办。"],
    ["周宁", "压低声音", "那我呢。我问你，我呢。"],
    ["周桂兰", "抬眼", "你过得好，我就放心。"],
    ["周宁", "苦笑", "我过得好？我连首付都凑不齐。"],
    ["【场景】老小区楼道", ""],
    ["周宁", "推开门，对楼道喊", "周凯，出来。"],
    ["周凯", "扶着墙，气短", "姐，你小点声。"],
    ["周宁", "把委托书拍他胸口", "你让妈把房子押了。"],
    ["周凯", "躲开眼神", "医院催款，我没别的办法。"],
    ["周宁", "怒", "你有办法啊，去找你那群酒肉朋友。"],
    ["周凯", "虚弱", "他们不接电话。"],
    ["周宁", "冷笑", "钱花完了，人就散了。"],
    ["周桂兰", "从门里追出来，拉周宁", "别在楼道里吵。"],
    ["邻居王婶", "探头，压低声音", "桂兰，你们小点声，孩子要写作业。"],
    ["周宁", "回头", "王婶，您别劝。这次必须说清楚。"],
    ["周桂兰", "对王婶赔笑", "对不起，我们进去说。"],
    ["【场景】银行大厅", ""],
    ["周宁", "把房产证拍在柜台上", "我要查这套房还有没有抵押。"],
    ["柜员", "看屏幕，平静", "周桂兰名下这套，去年办过一次抵押。"],
    ["周宁", "盯着她", "余额还有多少。"],
    ["柜员", "敲键盘", "剩余本金二十八万六。"],
    ["周桂兰", "抓住周宁袖口，发颤", "别查了。"],
    ["周宁", "甩开", "二十八万，全进医院了？"],
    ["周凯", "跟在后面，气短", "还有……还有利息。"],
    ["周宁", "转身", "你连利息都让妈扛。"],
    ["周凯", "低头", "我以为能还上。"],
    ["周宁", "提高音量", "你以为能还上的次数，我数不过来。"],
    ["柜员", "轻声", "需要打印明细吗。"],
    ["周宁", "点头", "打。每一笔都打。"],
    ["【场景】医院走廊", ""],
    ["周宁", "把明细单抖开", "周凯，你自己念。"],
    ["周凯", "看着单子，结巴", "这……这有两笔不是医药费。"],
    ["周宁", "逼近", "哪两笔。"],
    ["周凯", "声音发虚", "一笔转给了老冯。"],
    ["周桂兰", "愣住", "老冯是谁。"],
    ["周宁", "冷笑", "赌债。"],
    ["周凯", "急促", "我只借过一次。"],
    ["周宁", "把单子怼到他眼前", "一次十二万？"],
    ["周桂兰", "后退扶墙", "你拿救命钱去还赌。"],
    ["周凯", "跪下，痛哭", "妈，我错了。"],
    ["周宁", "看着他，压着火", "你错的不是这一次。"],
    ["护士", "路过，低声", "走廊别跪，影响过道。"],
    ["周宁", "把周凯拉起来", "起来。别演给别人看。"],
    ["周桂兰", "泪流", "我把房子押了，换来的是这个。"],
    ["【场景】周宁出租屋", ""],
    ["周宁", "把明细摊在小桌上", "妈，你看清楚。"],
    ["周桂兰", "戴上老花镜，发颤", "这两笔……真不是药费。"],
    ["周宁", "坐下，放慢", "所以不是我狠。是账在说话。"],
    ["周桂兰", "沉默良久", "我一直护他。"],
    ["周宁", "轻声", "你护他，就把我往外推。"],
    ["周桂兰", "抬头", "我不是这个意思。"],
    ["周宁", "苦笑", "可结果就是这样。"],
    ["周桂兰", "把房产证推过去", "这证你收着。"],
    ["周宁", "摇头", "我不要房子。我要你别再替他瞒。"],
    ["周桂兰", "哽咽", "那我该怎么办。"],
    ["周宁", "一字一顿", "明天去银行，停掉他的授权。"],
    ["周桂兰", "迟疑", "他会恨我。"],
    ["周宁", "看着她", "他已经把你恨成提款机了。"],
    ["【场景】老小区客厅", ""],
    ["周凯", "站在门口，虚弱", "姐，你别把卡停了。"],
    ["周宁", "把协议放到茶几上", "签。从今天起，房贷只走妈的账户。"],
    ["周凯", "低头", "我没钱签这个。"],
    ["周宁", "冷", "你没钱，就更不能碰这套房。"],
    ["周桂兰", "把笔递给他", "凯子，签吧。"],
    ["周凯", "握笔，发颤", "你们要把我赶出去。"],
    ["周宁", "摇头", "没赶你。是不让你再卖妈。"],
    ["周凯", "签字，气短", "我签。"],
    ["周桂兰", "拿过协议，泪还在", "这回听你姐的。"],
    ["周宁", "把房产证锁进铁盒", "证我保管。钥匙给你一份。"],
    ["周桂兰", "握住她的手", "宁宁，妈以前亏你了。"],
    ["周宁", "点头，声音发紧", "亏的账，从今天开始还。"],
    ["周凯", "站在原地，低声", "我去戒赌。"],
    ["周宁", "看着他", "先把十二万的流向写清楚。"],
    ["周凯", "点头", "我写。"],
    ["周桂兰", "沉默良久", "这套房，以后听你的。"],
    ["周宁", "哽咽", "不是听我的，是别再瞒。"],
    ["周凯", "一字一顿", "授权我自己去银行停。"],
    ["周宁", "看着房产证", "证先放铁盒里。"],
    ["周桂兰", "把铁盒钥匙递过去", "一把给你，一把我留着。"],
    ["周宁", "收钥匙", "明细单也锁进去。"],
    ["周凯", "低声", "协议原件呢。"],
    ["周宁", "拍铁盒", "和房产证放一起。"],
    ["周桂兰", "泪还在，放慢", "妈以前护错了人。"],
    ["周宁", "握住她的手", "从今天改过来就行。"],
    ["周凯", "站在门口，气短", "我明天去戒赌点报到。"],
    ["周宁", "点头", "报到条拍照发我。"],
    ["周桂兰", "看着两个孩子", "饭我热着，先把证锁好。"]
  ];

  const body = lines.map(item => {
    if (item[0].startsWith("【")) return item[0];
    return `${item[0]}（${item[1]}）：${item[2]}`;
  }).join("\n");

  return [
    "# 五分钟家庭对白稿｜《房产证》",
    "",
    "【总时长】约300-360秒",
    "【画幅】9:16 写实竖屏",
    "【成片硬规则】禁止字幕、标题、姓名条、价格字、水印与背景音乐；人物介绍和故事简介不得进入成片。",
    "【人物】周桂兰，63岁，灰白短发，深灰开衫；周宁，36岁，利落马尾，深蓝风衣；周凯，34岁，削瘦，旧军绿外套；王婶，68岁，邻家探头；柜员，28岁，银行制服；护士，30岁，白大褂。",
    "【场景】老小区客厅、老小区楼道、银行大厅、医院走廊、周宁出租屋。",
    "【核心道具】房产证、抵押明细单、授权停止协议、铁盒。",
    "【物品】@房产证 @抵押明细单 @授权停止协议 @铁盒 @手机 @茶杯 @椅子",
    "【故事简介】女儿周宁发现母亲把房产证拿去抵押，以为又是偏袒弟弟；银行明细揭开弟弟挪用救命钱还赌债。母亲交出房产证，当场停掉弟弟授权。周宁丈夫从未出场，只在关系里被提及一次也不建资产。",
    "",
    "## 正式剧情",
    "",
    "物品：@房产证 @抵押明细单 @授权停止协议 @铁盒",
    "",
    body
  ].join("\n");
}

function timedShot({ number, act, pace, scene, cast, props, weather, continuity, panels, turns, sound }) {
  const castLine = cast.map(name => `@${name}`).join(" ");
  const propLine = props.length ? props.map(name => `@${name}`).join(" ") : "@无";
  const panelLines = panels.map(panel => `${panel.start}-${panel.end}秒，【${panel.framing} ${panel.action}】；`).join("\n");
  const turnLines = turns.map(turn => (
    `@${turn.speaker}（音色：@${turn.speaker}，${turn.start}-${turn.end}秒，${turn.tone}）：${turn.text}`
  )).join("\n");
  return [
    number === 1 || act.changed ? `第 ${act.number} 幕：【${act.title}】` : "",
    `分镜 ${number}（${pace}）`,
    `场景：@${scene}`,
    `人物：${castLine}`,
    `物品：${propLine}`,
    `天气/灯光/氛围：${weather}`,
    `承接上一分镜：【${continuity}】`,
    `【0-15秒】镜头：`,
    panelLines,
    `【对话汇总】`,
    turnLines,
    `【音效】${sound}`,
    `【画面禁止项】无字幕、无标题、无姓名条、无水印、无背景音乐、无人物介绍卡。`
  ].filter(Boolean).join("\n");
}

function buildTimedScript() {
  const acts = [
    { number: 1, title: "当众施压", from: 1, to: 10 },
    { number: 2, title: "录音反转", from: 11, to: 16 },
    { number: 3, title: "协议回收", from: 17, to: 24 }
  ];
  const shots = [
    { scene: "开放办公区", cast: ["林夏", "赵衡"], props: [], weather: "白天冷白日光灯", continuity: "开篇全景引入", pace: "开场·快节奏",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "林夏抱着文件夹快步穿过工位，赵衡在她工位前等着" },
        { start: 5, end: 11, framing: "中景", action: "赵衡把一份离职协议拍在林夏桌上" },
        { start: 11, end: 15, framing: "近景", action: "林夏盯着协议抬头，手指扣紧文件夹" }
      ],
      turns: [
        { speaker: "赵衡", start: 3, end: 7, tone: "当众施压", text: "林夏，今天把离职签了。" },
        { speaker: "林夏", start: 7, end: 11, tone: "压着火", text: "我项目还没交接。" },
        { speaker: "赵衡", start: 11, end: 14.5, tone: "冷笑", text: "客户点名不要你。" }
      ], sound: "键盘声、协议拍桌、空调底噪" },
    { scene: "开放办公区", cast: ["林夏", "赵衡"], props: ["离职协议"], weather: "白天冷白日光灯", continuity: "协议仍摊在桌上", pace: "加压·中快",
      panels: [
        { start: 0, end: 4, framing: "特写", action: "离职协议封面特写，林夏的名字被红笔圈出" },
        { start: 4, end: 10, framing: "双人中景", action: "赵衡把笔塞到林夏手里" },
        { start: 10, end: 15, framing: "近景", action: "林夏不接笔，把录音笔从袖口按实" }
      ],
      turns: [
        { speaker: "赵衡", start: 2, end: 6, tone: "催促", text: "笔给你，别让全组等。" },
        { speaker: "林夏", start: 6, end: 10, tone: "压低声音", text: "理由写清楚再签。" },
        { speaker: "赵衡", start: 10, end: 14, tone: "提高音量", text: "理由就是你不适合。" }
      ], sound: "笔筒轻响、衣袖摩擦、工位低语" },
    { scene: "开放办公区", cast: ["林夏", "同事小吴"], props: ["录音笔"], weather: "白天冷白日光灯", continuity: "赵衡转身离开工位", pace: "反应·中等",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "小吴探过隔板，林夏把录音笔藏回袖口" },
        { start: 5, end: 10, framing: "近景", action: "小吴压低声音提醒她别硬刚" },
        { start: 10, end: 15, framing: "特写", action: "林夏看向总监办公室方向" }
      ],
      turns: [
        { speaker: "同事小吴", start: 2, end: 6, tone: "担心", text: "你别跟他对着干。" },
        { speaker: "林夏", start: 6, end: 10, tone: "咬字清楚", text: "他对着干的是证据。" },
        { speaker: "同事小吴", start: 10, end: 14, tone: "迟疑", text: "人事陈姐已经在会议室等你。" }
      ], sound: "隔板轻敲、远处打印、袖口按键轻响" },
    { scene: "总监办公室", cast: ["林夏", "赵衡"], props: ["离职协议"], weather: "百叶窗斜光，室内偏冷", continuity: "林夏被叫进办公室", pace: "对峙·中慢",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "林夏关上门，赵衡坐在宽桌后" },
        { start: 5, end: 11, framing: "越肩", action: "赵衡把协议推过桌面" },
        { start: 11, end: 15, framing: "近景", action: "林夏不坐，双手撑桌" }
      ],
      turns: [
        { speaker: "赵衡", start: 3, end: 7, tone: "假客气", text: "关上门，给彼此留点面子。" },
        { speaker: "林夏", start: 7, end: 11, tone: "冷静", text: "面子是你当众撕的。" },
        { speaker: "赵衡", start: 11, end: 14.5, tone: "压低威胁", text: "客户邮件我可以再写一封。" }
      ], sound: "关门、椅子轻响、中央空调" },
    { scene: "总监办公室", cast: ["林夏", "赵衡"], props: ["录音笔"], weather: "百叶窗斜光", continuity: "威胁话落在桌上", pace: "加压·快",
      panels: [
        { start: 0, end: 5, framing: "近景", action: "赵衡站起来绕过桌子" },
        { start: 5, end: 10, framing: "中景", action: "林夏后退半步，袖口里录音笔红点一闪" },
        { start: 10, end: 15, framing: "特写", action: "赵衡的手按在协议签名栏上" }
      ],
      turns: [
        { speaker: "赵衡", start: 2, end: 6, tone: "逼近", text: "你要是闹，行业里就没你了。" },
        { speaker: "林夏", start: 6, end: 10, tone: "盯着他", text: "那你现在说的，都能算数。" },
        { speaker: "赵衡", start: 10, end: 14, tone: "冷笑", text: "算。你自己听清楚。" }
      ], sound: "皮鞋落地、纸张摩擦、极轻按键声" },
    { scene: "总监办公室", cast: ["林夏", "赵衡"], props: ["离职协议"], weather: "室内冷光", continuity: "赵衡承认自己会再写邮件", pace: "证据铺垫·中等",
      panels: [
        { start: 0, end: 6, framing: "中景", action: "赵衡回到座位打开电脑" },
        { start: 6, end: 11, framing: "近景", action: "屏幕上是一份未发送的客户投诉草稿" },
        { start: 11, end: 15, framing: "双人", action: "林夏看见草稿抬头" }
      ],
      turns: [
        { speaker: "林夏", start: 3, end: 7, tone: "质问", text: "客户投诉是你写的。" },
        { speaker: "赵衡", start: 7, end: 11, tone: "不屑", text: "客户怎么想，你管不着。" },
        { speaker: "林夏", start: 11, end: 14.5, tone: "压着火", text: "你把我名字写进去了。" }
      ], sound: "鼠标点击、屏幕风扇、纸页翻动" },
    { scene: "地下车库", cast: ["林夏", "赵衡"], props: ["录音笔"], weather: "夜晚钠灯，地面反光", continuity: "赵衡约她车库再谈", pace: "压迫·中快",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "空荡车库，赵衡靠着黑色轿车" },
        { start: 5, end: 10, framing: "中景", action: "林夏走过去，手插在风衣口袋按住录音笔" },
        { start: 10, end: 15, framing: "近景", action: "赵衡把车钥匙转了一圈" }
      ],
      turns: [
        { speaker: "赵衡", start: 2, end: 6, tone: "压低", text: "这儿没监控死角，你想清楚。" },
        { speaker: "林夏", start: 6, end: 10, tone: "冷静", text: "你怕监控，还是怕我说出去。" },
        { speaker: "赵衡", start: 10, end: 14, tone: "威胁", text: "签了，补偿多给一个月。" }
      ], sound: "远处引擎、钥匙金属声、脚步回响" },
    { scene: "地下车库", cast: ["林夏", "赵衡"], props: ["离职协议"], weather: "夜晚钠灯", continuity: "补偿条件被甩出来", pace: "加压·快",
      panels: [
        { start: 0, end: 5, framing: "近景", action: "赵衡从公文包抽出第二份协议" },
        { start: 5, end: 11, framing: "特写", action: "协议上多了一行封口费" },
        { start: 11, end: 15, framing: "中景", action: "林夏不接，只看着他" }
      ],
      turns: [
        { speaker: "赵衡", start: 2, end: 7, tone: "利诱", text: "多一个月，换你闭嘴。" },
        { speaker: "林夏", start: 7, end: 11, tone: "冷", text: "你承认这是封口费。" },
        { speaker: "赵衡", start: 11, end: 14.5, tone: "不耐烦", text: "爱怎么叫怎么叫。" }
      ], sound: "公文包拉链、纸页拍车盖、回声" },
    { scene: "地下车库", cast: ["林夏"], props: ["录音笔"], weather: "夜晚钠灯", continuity: "赵衡上车离开", pace: "独处·中慢",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "轿车开走，林夏独自站在车位" },
        { start: 5, end: 10, framing: "近景", action: "她掏出录音笔回放最后一句" },
        { start: 10, end: 15, framing: "特写", action: "录音笔屏幕显示仍在录" }
      ],
      turns: [
        { speaker: "林夏", start: 4, end: 8, tone: "对自己说，压低", text: "封口费，你亲口说的。" },
        { speaker: "林夏", start: 9, end: 13, tone: "吸气后更稳", text: "明天会议室见。" }
      ], sound: "远去引擎、录音回放电流、鞋跟" },
    { scene: "林夏出租屋", cast: ["林夏"], props: ["录音笔"], weather: "夜晚台灯暖黄", continuity: "她回家整理证据", pace: "准备·中等",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "林夏把录音笔连上笔记本" },
        { start: 5, end: 10, framing: "特写", action: "屏幕出现波形，她截出封口费那句" },
        { start: 10, end: 15, framing: "近景", action: "她把U盘和协议复印件放进文件袋" }
      ],
      turns: [
        { speaker: "林夏", start: 3, end: 7, tone: "对自己，冷静", text: "这一句够了。" },
        { speaker: "林夏", start: 8, end: 13, tone: "决定", text: "明天换套衣服，去见陈姐。" }
      ], sound: "键盘、U盘插入、拉链" },
    { scene: "会议室", cast: ["林夏", "陈姐"], props: ["录音笔"], weather: "白天会议室均匀白光", continuity: "林夏换上黑色西装走进会议室", pace: "反转铺垫·中等",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "林夏已换上黑色西装，把文件袋放到长桌上" },
        { start: 5, end: 10, framing: "中景", action: "陈姐推门进来，看见她的着装一顿" },
        { start: 10, end: 15, framing: "近景", action: "林夏把录音笔立在桌面上" }
      ],
      turns: [
        { speaker: "陈姐", start: 3, end: 7, tone: "意外", text: "你今天换上黑色西装了。" },
        { speaker: "林夏", start: 7, end: 11, tone: "平静", text: "正式谈，得像样一点。" },
        { speaker: "陈姐", start: 11, end: 14.5, tone: "谨慎", text: "赵总说你自愿离职。" }
      ], sound: "门吸合、椅子拉动、录音笔轻放" },
    { scene: "会议室", cast: ["林夏", "陈姐"], props: ["录音笔"], weather: "白天均匀白光", continuity: "自愿离职被戳破", pace: "主反转·中快",
      panels: [
        { start: 0, end: 5, framing: "近景", action: "林夏按下播放，赵衡的声音在房间里响起" },
        { start: 5, end: 10, framing: "中景", action: "陈姐脸色变了，伸手要停" },
        { start: 10, end: 15, framing: "特写", action: "录音笔继续播出封口费三个字" }
      ],
      turns: [
        { speaker: "林夏", start: 1, end: 4, tone: "冷静", text: "你听完再拦。" },
        { speaker: "陈姐", start: 8, end: 12, tone: "发紧", text: "这是他亲口说的？" },
        { speaker: "林夏", start: 12, end: 14.8, tone: "肯定", text: "车库里，亲口。" }
      ], sound: "录音回放、椅子后移、空调" },
    { scene: "会议室", cast: ["林夏", "赵衡", "陈姐"], props: ["录音笔"], weather: "白天均匀白光", continuity: "赵衡推门进来", pace: "对质·快",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "赵衡进门看见立着的录音笔" },
        { start: 5, end: 10, framing: "中景", action: "他要伸手抢，陈姐按住他手腕" },
        { start: 10, end: 15, framing: "近景", action: "林夏把手机也亮出备份文件" }
      ],
      turns: [
        { speaker: "赵衡", start: 2, end: 5, tone: "怒", text: "你偷录。" },
        { speaker: "林夏", start: 5, end: 9, tone: "盯着他", text: "你先威胁，我才录。" },
        { speaker: "陈姐", start: 9, end: 14, tone: "提高音量", text: "都坐下。现在按流程走。" }
      ], sound: "门撞、桌面震动、手机亮屏" },
    { scene: "会议室", cast: ["林夏", "赵衡", "陈姐"], props: ["离职协议"], weather: "白天均匀白光", continuity: "陈姐接管现场", pace: "清算·中等",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "陈姐把两份离职协议摊开对比" },
        { start: 5, end: 10, framing: "特写", action: "封口费那一行被她用手指点住" },
        { start: 10, end: 15, framing: "双人", action: "赵衡靠回椅背，林夏不让眼" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "公事公办", text: "第二份不是公司模板。" },
        { speaker: "赵衡", start: 6, end: 10, tone: "辩解", text: "那是沟通方案。" },
        { speaker: "林夏", start: 10, end: 14, tone: "打断", text: "你自己说的，封口费。" }
      ], sound: "纸页对比、手指点纸、椅子靠背" },
    { scene: "会议室", cast: ["林夏", "陈姐"], props: ["录音笔"], weather: "白天均匀白光", continuity: "赵衡被请出会场", pace: "证据固化·中慢",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "陈姐让林夏把音频拷进公司电脑" },
        { start: 5, end: 10, framing: "特写", action: "拷贝进度条走完，她当场写接收回执" },
        { start: 10, end: 15, framing: "近景", action: "林夏在回执上签字" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "稳", text: "原件你留，备份公司收。" },
        { speaker: "林夏", start: 6, end: 10, tone: "确认", text: "回执上写清时间和出处。" },
        { speaker: "陈姐", start: 10, end: 14, tone: "点头", text: "写。今天就立案。" }
      ], sound: "U盘插入、打印回执、签字" },
    { scene: "人事办公室", cast: ["林夏", "陈姐"], props: ["离职协议"], weather: "下午侧光", continuity: "立案后单独谈话", pace: "收束铺垫·中等",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "陈姐把伪造协议装进证物袋" },
        { start: 5, end: 10, framing: "近景", action: "她把林夏的工牌推回去" },
        { start: 10, end: 15, framing: "双人", action: "林夏没有立刻去拿" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "正式", text: "你不用签离职。" },
        { speaker: "林夏", start: 6, end: 10, tone: "仍紧", text: "那赵衡呢。" },
        { speaker: "陈姐", start: 10, end: 14.5, tone: "清楚", text: "停职，等调查。" }
      ], sound: "证物袋封口、工牌轻放、打印机远处响" },
    { scene: "开放办公区", cast: ["林夏", "同事小吴"], props: [], weather: "下午日光灯", continuity: "林夏仍穿着黑色西装走回工位", pace: "关系回收·中等",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "工位里有人偷看，又迅速低头" },
        { start: 5, end: 10, framing: "中景", action: "小吴把一杯水放到她桌上" },
        { start: 10, end: 15, framing: "近景", action: "林夏点头，没有笑" }
      ],
      turns: [
        { speaker: "同事小吴", start: 3, end: 7, tone: "小心", text: "你还回来坐。" },
        { speaker: "林夏", start: 7, end: 11, tone: "平静", text: "我没走。" },
        { speaker: "同事小吴", start: 11, end: 14, tone: "松口气", text: "刚才全组都听见了。" }
      ], sound: "键盘恢复、水杯放下、远处讨论压低" },
    { scene: "总监办公室", cast: ["赵衡", "陈姐"], props: ["离职协议"], weather: "百叶窗已拉上", continuity: "陈姐进办公室收权限", pace: "惩罚·中快",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "陈姐收走赵衡的门禁卡" },
        { start: 5, end: 10, framing: "近景", action: "赵衡想解释，手停在半空" },
        { start: 10, end: 15, framing: "特写", action: "电脑登录被远程退出" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "公事", text: "从现在起停职。" },
        { speaker: "赵衡", start: 6, end: 10, tone: "发虚", text: "我可以解释。" },
        { speaker: "陈姐", start: 10, end: 14, tone: "打断", text: "去监察室解释。" }
      ], sound: "门禁卡碰桌、键盘远程退出、百叶窗" },
    { scene: "监察室", cast: ["林夏", "赵衡", "陈姐"], props: ["录音笔"], weather: "审讯灯偏白", continuity: "三方对笔录", pace: "对质收束·中等",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "长桌两端坐下，录音笔作为证物摆在中间" },
        { start: 5, end: 10, framing: "中景", action: "赵衡签字确认录音真实性" },
        { start: 10, end: 15, framing: "近景", action: "林夏看着他签完才眨眼" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "宣读", text: "确认这是你的声音。" },
        { speaker: "赵衡", start: 6, end: 10, tone: "低", text: "是。" },
        { speaker: "林夏", start: 10, end: 14, tone: "不抬高", text: "那就按真的处理。" }
      ], sound: "笔尖、翻页、日光灯电流" },
    { scene: "人事办公室", cast: ["林夏", "陈姐"], props: [], weather: "傍晚侧光", continuity: "笔录结束", pace: "结果·中慢",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "陈姐把恢复职务通知递给林夏" },
        { start: 5, end: 10, framing: "近景", action: "林夏看完，把它放进文件袋" },
        { start: 10, end: 15, framing: "双人", action: "两人没有握手，只点头" }
      ],
      turns: [
        { speaker: "陈姐", start: 2, end: 6, tone: "正式", text: "你的职级保留。" },
        { speaker: "林夏", start: 6, end: 10, tone: "确认", text: "项目我接着做。" },
        { speaker: "陈姐", start: 10, end: 14, tone: "补一句", text: "下次别一个人去车库。" }
      ], sound: "纸袋、椅子轻移、窗外车流" },
    { scene: "开放办公区", cast: ["林夏"], props: ["录音笔"], weather: "傍晚，部分工位已关灯", continuity: "她回到自己工位", pace: "余韵·慢",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "林夏把录音笔放进抽屉最里面" },
        { start: 5, end: 10, framing: "特写", action: "她锁上抽屉，钥匙收进西装内袋" },
        { start: 10, end: 15, framing: "近景", action: "她坐下打开未完成的项目文档" }
      ],
      turns: [
        { speaker: "林夏", start: 4, end: 8, tone: "对自己，低", text: "证据锁好。" },
        { speaker: "林夏", start: 9, end: 13, tone: "呼气后恢复", text: "活还得干完。" }
      ], sound: "抽屉锁、键盘、远处电梯" },
    { scene: "地下车库", cast: ["林夏"], props: [], weather: "夜晚钠灯，比之前更空", continuity: "下班她再次经过车库", pace: "对照·中慢",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "同一车位空着，林夏走过但不停留" },
        { start: 5, end: 10, framing: "中景", action: "她看了一眼监控探头" },
        { start: 10, end: 15, framing: "近景", action: "她继续走向楼梯，背影稳定" }
      ],
      turns: [
        { speaker: "林夏", start: 6, end: 10, tone: "低声", text: "这儿不是死角。" },
        { speaker: "林夏", start: 11, end: 14, tone: "收住", text: "下次有人。" }
      ], sound: "脚步回响、远车、风" },
    { scene: "开放办公区", cast: ["林夏", "同事小吴"], props: [], weather: "次日早晨冷白光", continuity: "第二天她仍穿着黑色西装来上班", pace: "收束·中等",
      panels: [
        { start: 0, end: 5, framing: "全景", action: "早晨工位陆续坐满，林夏准时坐下" },
        { start: 5, end: 10, framing: "中景", action: "小吴把项目资料递给她" },
        { start: 10, end: 15, framing: "近景", action: "林夏接过，开始翻页" }
      ],
      turns: [
        { speaker: "同事小吴", start: 3, end: 7, tone: "试探", text: "赵总的位子空着。" },
        { speaker: "林夏", start: 7, end: 11, tone: "不看那边", text: "空着就空着。" },
        { speaker: "同事小吴", start: 11, end: 14, tone: "点头", text: "那客户会还是你跟。" }
      ], sound: "晨间键盘、翻页、咖啡机远处" },
    { scene: "会议室", cast: ["林夏", "陈姐"], props: [], weather: "早晨侧光", continuity: "客户会前最后确认", pace: "结局·稳",
      panels: [
        { start: 0, end: 5, framing: "中景", action: "投屏亮起项目页，林夏站在桌边" },
        { start: 5, end: 10, framing: "近景", action: "陈姐把新的授权函放到她手边" },
        { start: 10, end: 15, framing: "全景", action: "两人看向门口，等待客户推门" }
      ],
      turns: [
        { speaker: "陈姐", start: 3, end: 7, tone: "正式", text: "客户对接改你全权。" },
        { speaker: "林夏", start: 7, end: 11, tone: "点头", text: "我按原方案讲。" },
        { speaker: "陈姐", start: 11, end: 14.5, tone: "收尾", text: "门开了就开始。" }
      ], sound: "投屏风扇、纸页、门外脚步" }
  ];

  const blocks = shots.map((shot, index) => {
    const number = index + 1;
    const act = acts.find(item => number >= item.from && number <= item.to);
    return timedShot({
      ...shot,
      number,
      act: { number: act.number, title: act.title, changed: number === act.from }
    });
  });

  return [
    "# 六分钟职场秒级分镜稿｜《封口费》",
    "",
    "【总时长】360秒（24个15秒分镜）",
    "【画幅】9:16 写实竖屏",
    "【成片硬规则】禁止字幕、标题、姓名条、水印、背景音乐和人物介绍卡。",
    "【人物】林夏，28岁，职场女性，先浅蓝衬衫后换上黑色西装；赵衡，45岁，总监，深灰西装；陈姐，50岁，人事经理，深色套装；同事小吴，26岁，格子衬衫。",
    "【场景】开放办公区、总监办公室、地下车库、林夏出租屋、会议室、人事办公室、监察室。",
    "【核心道具】录音笔、离职协议。电脑、椅子、水杯只作环境陈设。",
    "【故事】总监当众逼员工签离职并在车库许封口费；员工用录音笔取证，换上黑色西装走人事程序，对方停职，她留下做项目。",
    "",
    ...blocks
  ].join("\n\n");
}

function productionShot(number, sceneId, sceneName, characterIds, action, stage, beat, start, end, dialogue, product = "不出现", kindness = "无") {
  const id = `S${String(number).padStart(2, "0")}`;
  const dialogueLine = dialogue.map(item => `${item.speaker}（${item.tone}）：${item.text}`).join(" / ");
  const spokenLines = dialogue.map(item => `${item.speaker}（${item.tone}）：${item.text}`);
  const sub1 = dialogue[0] ? `${dialogue[0].speaker}说完并看向对方` : action;
  const sub2 = dialogue[1] ? `${dialogue[1].speaker}回应并改变站位` : "听者或对手给出可见反应";
  const sub3 = `${end}，动作结果落地`;
  return [
    `### ${id}｜10秒｜${sceneName}`,
    `- 人物：${characterIds.join(" ")}`,
    `- 场景：${sceneId}`,
    `- 动作：${action}｜阶段${stage}｜推进${beat}｜代价${kindness}｜起始${start}｜结束${end}`,
    `- 对白：${dialogueLine}`,
    ...spokenLines,
    `- 情绪：从对峙压到可见结果`,
    `- 声音：连续现场底噪与同步动作声，禁止背景音乐`,
    `- 描述：缴费单是反转证物；本镜只锁动作和对白，不另建环境陈设资产`,
    `- 商品：${product}`,
    `- subshot 1｜0.0-3.0秒｜近景：${sub1}；对白：${dialogue[0] ? `${dialogue[0].speaker}：${dialogue[0].text}` : "无"}；声音：现场底噪；切到听者`,
    `- subshot 2｜3.0-7.0秒｜反打：${sub2}；对白：${dialogue[1] ? `${dialogue[1].speaker}：${dialogue[1].text}` : (dialogue[0] ? "听者反应，无新增台词" : "无")}；声音：同步动作；切到结果`,
    `- subshot 3｜7.0-10.0秒｜动作结果：${sub3}；对白：${dialogue[2] ? `${dialogue[2].speaker}：${dialogue[2].text}` : "无"}；声音：环境声连续；接下单元`
  ].join("\n");
}

function buildProductionScript() {
  const characters = [
    ["C01", "苏妈", "58岁，花白齐耳短发，深棕开衫，右手指节有旧冻伤。资产指纹：右眉一颗痣、微驼、指节冻伤。声线：低、慢、带乡镇口音。测试台词：这单子你看清楚。"],
    ["C02", "苏远", "32岁，短寸，深蓝夹克，眼下青黑。资产指纹：左耳耳钉孔、虎牙、肩窄。声线：快、硬、尾音往下压。测试台词：医院的钱呢。"],
    ["C03", "王婶", "60岁，邻居，碎花棉袄。资产指纹：金耳环、缺一颗门牙。声线：亮、碎、爱插话。测试台词：我看见她凌晨还在搓手。"]
  ];
  const scenes = [
    ["SC01", "苏妈厨房｜傍晚", "狭窄老式厨房，煤气灶、铁水池、窗台冻手处。环境声：抽油烟机与窗外车。"],
    ["SC02", "社区诊所走廊｜白天", "白墙长椅、缴费窗口、塑胶地板。环境声：叫号与拖鞋。"],
    ["SC03", "苏远出租屋｜夜晚", "单间床铺、纸箱、小桌。环境声：楼上脚步与水管。"],
    ["SC04", "社区小卖部｜夜晚", "货架、暖柜、玻璃门。环境声：冰箱与塑料袋。"]
  ];

  const units = [
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远摔门质问医院缴费单去向", "hook", "缴费单失踪引爆母子冲突", "苏远摔门进厨房", "苏妈把缴费单按在胸口",
      [{ speaker: "苏远", tone: "摔门，压着火", text: "缴费单呢。" }, { speaker: "苏妈", tone: "发颤", text: "我收着。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远抢缴费单被苏妈护住", "pressure", "儿子要单子，母亲护证据", "苏妈护住胸口", "单子边角被扯出一截",
      [{ speaker: "苏远", tone: "提高音量", text: "给我。" }, { speaker: "苏妈", tone: "抓紧", text: "你看了会急。" }], "不出现", "苏妈用手挡住撕扯"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远指责母亲乱花钱", "pressure", "冲突从单子转到钱", "单子边角外露", "苏远甩开抹布",
      [{ speaker: "苏远", tone: "冷笑", text: "又给街坊垫钱。" }, { speaker: "苏妈", tone: "急", text: "我没乱花。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C03"], "王婶推门看见冲突", "pressure", "邻居目击让矛盾公开", "王婶推门", "苏远背对她",
      [{ speaker: "王婶", tone: "探头", text: "又吵啊。" }, { speaker: "苏妈", tone: "赔笑", text: "家里事。" }], "不出现", "苏妈当众护短"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "母子到诊所对窗口", "escalation", "把家事拖到公共窗口", "两人站到窗口", "苏远拍窗台",
      [{ speaker: "苏远", tone: "对窗口", text: "查上周那笔。" }, { speaker: "苏妈", tone: "拉他", text: "别当众吼。" }], "不出现", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "窗口说出缴费单金额", "evidence", "金额成为第一证据", "窗口递出回执复印件", "苏远盯着数字",
      [{ speaker: "苏远", tone: "盯单", text: "八百六。" }, { speaker: "苏妈", tone: "低", text: "药费是这个数。" }], "不出现", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "苏远追问剩下的钱", "escalation", "钱对不上开始加压", "复印件在他手里", "苏妈避开视线",
      [{ speaker: "苏远", tone: "逼问", text: "我打给你的两千呢。" }, { speaker: "苏妈", tone: "迟疑", text: "我留下一点。" }], "不出现", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C03"], "王婶在走廊插话", "escalation", "邻居泄露苏妈凌晨搓手", "王婶坐下", "苏妈攥紧自己的手",
      [{ speaker: "王婶", tone: "热心", text: "她凌晨还在搓手。" }, { speaker: "苏妈", tone: "打断", text: "别说这个。" }], "不出现", "苏妈当众忍痛"],
    ["SC03", "苏远出租屋", ["C02"], "苏远独自翻聊天记录", "pressure", "儿子用旧转账刺激自己", "他坐在床边", "手机停在转账页",
      [{ speaker: "苏远", tone: "对自己", text: "两千，一笔都在。" }, { speaker: "苏远", tone: "冷", text: "她不说实话。" }], "不出现", "无"],
    ["SC03", "苏远出租屋", ["C01", "C02"], "苏妈上门送饺子", "cost_kindness", "母亲用食物换停战", "苏妈进门放碗", "苏远不吃",
      [{ speaker: "苏妈", tone: "放软", text: "先吃饭。" }, { speaker: "苏远", tone: "推开碗", text: "先把账说清。" }], "不出现", "苏妈专程送吃的被拒"],
    ["SC03", "苏远出租屋", ["C01", "C02"], "苏妈承认垫了别人的药", "evidence", "善意被误解成乱花钱", "碗被推开", "苏妈坐下",
      [{ speaker: "苏妈", tone: "承认", text: "我给王婶垫过药。" }, { speaker: "苏远", tone: "拍桌", text: "我就知道。" }], "不出现", "苏妈垫钱"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "回家后苏远翻抽屉", "escalation", "翻找把冲突落到物证", "抽屉被拉开", "缴费单原件出现",
      [{ speaker: "苏远", tone: "翻找", text: "原件在这儿。" }, { speaker: "苏妈", tone: "伸手", text: "别撕。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远看见单子背后的手写", "evidence", "背面字迹成为新线索", "他翻到背面", "苏妈想抢",
      [{ speaker: "苏远", tone: "念", text: "留给远子取暖。" }, { speaker: "苏妈", tone: "慌", text: "那是乱写的。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远不信取暖两个字", "pressure", "误解升级为指责装穷", "单子在两人之间", "苏妈捂手",
      [{ speaker: "苏远", tone: "讽刺", text: "你还会取暖。" }, { speaker: "苏妈", tone: "捂手", text: "手疼。" }], "不出现", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "复诊时医生提起冻伤", "evidence", "第三方证实手伤", "医生在门口说话", "苏远一顿",
      [{ speaker: "苏远", tone: "追问", text: "她手怎么了。" }, { speaker: "苏妈", tone: "打断医生", text: "老毛病。" }], "不出现", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "苏远逼母亲亮手", "escalation", "旧伤被当众摊开", "苏妈不肯伸手", "最后摊开指节",
      [{ speaker: "苏远", tone: "压低", text: "把手伸出来。" }, { speaker: "苏妈", tone: "慢慢伸", text: "别看太久。" }], "不出现", "苏妈当众亮伤"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "晚上停电厨房很冷", "pressure", "冷是后边商品的情境因", "灯灭", "苏妈搓手",
      [{ speaker: "苏远", tone: "皱眉", text: "又停电。" }, { speaker: "苏妈", tone: "搓手", text: "等一会就来。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C03"], "王婶送蜡烛并提起暖柜", "escalation", "邻居把取暖问题说破", "蜡烛点燃", "苏妈不接话",
      [{ speaker: "王婶", tone: "碎嘴", text: "小卖部暖柜还开着。" }, { speaker: "苏妈", tone: "挡", text: "我不用。" }], "不出现", "无"],
    ["SC03", "苏远出租屋", ["C02"], "苏远回想单子背面那行字", "main_reversal", "他开始怀疑自己错怪", "他盯着复印件背面", "他把夹克穿上",
      [{ speaker: "苏远", tone: "对自己", text: "留给远子取暖。" }, { speaker: "苏远", tone: "站起", text: "我去看看。" }], "不出现", "无"],
    ["SC04", "社区小卖部", ["C02", "C03"], "苏远问王婶母亲买过什么", "main_reversal", "邻居说出她只看不买", "两人站在货架前", "王婶指暖柜",
      [{ speaker: "苏远", tone: "问", text: "我妈来过这儿。" }, { speaker: "王婶", tone: "点头", text: "她看了暖手的，没买。" }], "不出现", "无"],
    ["SC04", "社区小卖部", ["C02"], "苏远看见暖柜里的折叠暖手宝", "product_enter", "商品因取暖情境自然出现", "他停在暖柜前", "他拿起一盒",
      [{ speaker: "苏远", tone: "低", text: "就这个。" }, { speaker: "苏远", tone: "看包装", text: "能捂手。" }], "出现：无品牌折叠暖手宝，只还原包装与形状，不报价格", "无"],
    ["SC04", "社区小卖部", ["C02"], "苏远付款带走暖手宝", "product_use", "购买是儿子的补救动作", "他付钱", "塑料袋提在手里",
      [{ speaker: "苏远", tone: "对店员", text: "就要这盒。" }, { speaker: "苏远", tone: "接过", text: "装好。" }], "出现：无品牌折叠暖手宝被装袋", "苏远花钱补救"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远回家把暖手宝放到母亲手上", "payoff", "商品完成取暖功能", "他拆开包装", "苏妈握住发热体",
      [{ speaker: "苏远", tone: "放软", text: "捂着。" }, { speaker: "苏妈", tone: "一愣", text: "你买这个。" }], "出现：暖手宝被塞进苏妈手里并开始发热", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏妈承认剩下的钱是准备买这个", "payoff", "两千的去向被回收", "她仍握着暖手宝", "缴费单被放到桌上",
      [{ speaker: "苏妈", tone: "小声", text: "剩下的钱，我想买这个。" }, { speaker: "苏远", tone: "哑", text: "你该早说。" }], "出现：暖手宝持续在手里", "苏妈省钱给儿子留取暖"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远把缴费单折好还给母亲", "payoff", "物证从指控变成共同账本", "他折单子", "苏妈收下",
      [{ speaker: "苏远", tone: "递回", text: "单子你收好。" }, { speaker: "苏妈", tone: "点头", text: "以后不瞒你。" }], "不直接出现", "无"],
    ["SC03", "苏远出租屋", ["C01", "C02"], "苏妈把备用暖手宝留给儿子", "payoff", "同一商品完成关系回收", "她把第二只放下", "苏远接住",
      [{ speaker: "苏妈", tone: "塞给他", text: "你屋里也冷。" }, { speaker: "苏远", tone: "接住", text: "我留下。" }], "出现：第二只暖手宝留在出租屋", "苏妈把仅剩的一只分给儿子"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "复诊时苏远替母亲交费", "payoff", "钱的流向被纠正", "他到窗口", "回执拿到苏妈手里",
      [{ speaker: "苏远", tone: "对窗口", text: "这笔我交。" }, { speaker: "苏妈", tone: "拉袖", text: "你钱不多。" }], "不出现", "苏远承担后续药费"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "电来了两人坐回桌边", "resolution", "冲突落地为日常", "灯亮", "暖手宝还在苏妈手里",
      [{ speaker: "苏远", tone: "坐下", text: "饺子我热一下。" }, { speaker: "苏妈", tone: "应", text: "碗在柜子里。" }], "出现：暖手宝作为生活动作留在手里", "无"],
    ["SC01", "苏妈厨房", ["C01", "C03"], "王婶再探头被挡回去", "resolution", "家事不再对外演", "王婶探头", "苏妈把门挡住",
      [{ speaker: "王婶", tone: "好奇", text: "还吵吗。" }, { speaker: "苏妈", tone: "平静", text: "不吵了。" }], "不出现", "无"],
    ["SC04", "社区小卖部", ["C02"], "苏远把空包装扔进店外桶", "product_result", "使用结果可见", "他展开空盒", "扔进桶里",
      [{ speaker: "苏远", tone: "看盒", text: "发热是真的。" }, { speaker: "苏远", tone: "扔掉", text: "够用就行。" }], "出现：空包装被丢掉，不出现价格字", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏远给母亲涂手霜", "resolution", "冻伤被认真对待", "他挤药膏", "苏妈忍着",
      [{ speaker: "苏远", tone: "低", text: "以后别硬扛。" }, { speaker: "苏妈", tone: "抽手又放下", text: "我听你的。" }], "不出现", "无"],
    ["SC03", "苏远出租屋", ["C02"], "他给母亲发转账备注取暖", "resolution", "钱的名义被纠正", "手机备注", "发送成功",
      [{ speaker: "苏远", tone: "打字", text: "备注写取暖。" }, { speaker: "苏远", tone: "发出", text: "这次说清楚。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "苏妈收到转账后回一句够了", "resolution", "不再互相试探", "她看手机", "把手机扣上",
      [{ speaker: "苏妈", tone: "看手机", text: "够了。" }, { speaker: "苏远", tone: "应", text: "不够你再说。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "两人把缴费单和暖手宝放在同一抽屉", "resolution", "证据和补救物共存", "抽屉打开", "两样东西并排放好",
      [{ speaker: "苏远", tone: "放好", text: "单子和这个放一起。" }, { speaker: "苏妈", tone: "关上抽屉", text: "省得再翻。" }], "出现：暖手宝与缴费单一起入抽屉", "无"],
    ["SC02", "社区诊所走廊", ["C01", "C02"], "下次叫号时苏远陪着坐", "resolution", "关系从质问变成陪伴", "两人坐长椅", "叫号响起",
      [{ speaker: "苏远", tone: "轻", text: "到了叫我。" }, { speaker: "苏妈", tone: "点头", text: "你先闭眼。" }], "不出现", "无"],
    ["SC01", "苏妈厨房", ["C01", "C02"], "夜里再停电，两人不再吵", "ending", "同一停电情境被回收", "灯再灭", "暖手宝被推过桌面",
      [{ speaker: "苏远", tone: "把暖手宝推过去", text: "先捂着。" }, { speaker: "苏妈", tone: "握住", text: "这次听你的。" }], "出现：暖手宝在停电里被使用", "无"]
  ];

  // Pad to 42 shots by expanding last-act domestic beats with unique dialogue
  while (units.length < 42) {
    const n = units.length + 1;
    const extra = [
      ["SC01", "苏妈厨房", ["C01", "C02"], `停电后两人确认第二天买菜钱`, "ending", "日常账不再瞒", "蜡烛还在", "苏妈把零钱盒推过来",
        [{ speaker: "苏远", tone: "问", text: "菜钱还够吗。" }, { speaker: "苏妈", tone: "推盒", text: "盒子里有。" }], "不出现", "无"],
      ["SC01", "苏妈厨房", ["C01", "C02"], `苏远把零钱盒钥匙留给母亲`, "ending", "钱箱控制权归还", "钥匙放下", "苏妈收下",
        [{ speaker: "苏远", tone: "放钥匙", text: "钥匙你拿着。" }, { speaker: "苏妈", tone: "收", text: "我不再乱垫。" }], "不出现", "无"],
      ["SC03", "苏远出租屋", ["C02"], `苏远把旧指责聊天记录删掉`, "ending", "误判记录被清", "他盯着屏幕", "删除完成",
        [{ speaker: "苏远", tone: "低", text: "这些话作废。" }, { speaker: "苏远", tone: "删掉", text: "以后当面说。" }], "不出现", "无"],
      ["SC01", "苏妈厨房", ["C01", "C02"], `清晨苏妈把热粥端上桌`, "ending", "关系回到一起吃饭", "粥放下", "两人坐下",
        [{ speaker: "苏妈", tone: "端碗", text: "趁热。" }, { speaker: "苏远", tone: "拿勺", text: "我再盛一碗给你。" }], "不出现", "无"],
      ["SC01", "苏妈厨房", ["C01", "C02"], `出门前苏远帮母亲把暖手宝放进外套`, "ending", "商品最后一次承担生活动作", "他拉开外套口袋", "暖手宝进袋",
        [{ speaker: "苏远", tone: "塞口袋", text: "出门也捂着。" }, { speaker: "苏妈", tone: "拍拍口袋", text: "知道了。" }], "出现：暖手宝进外套口袋", "无"],
      ["SC02", "社区诊所走廊", ["C01", "C02"], `挂号窗口前苏远替母亲说话`, "ending", "公开场合由儿子承担", "窗口叫号", "苏远上前",
        [{ speaker: "苏远", tone: "对窗口", text: "她复诊。" }, { speaker: "苏妈", tone: "轻声", text: "你说就行。" }], "不出现", "无"]
    ];
    units.push(extra[(n - 37) % extra.length]);
  }

  const shotBlocks = units.slice(0, 42).map((unit, index) => productionShot(index + 1, ...unit));
  return [
    "# 七分钟带货制作稿｜《留给远子取暖》",
    "",
    "【总时长】420秒（42个10秒制作单元）",
    "【画幅】9:16 写实竖屏",
    "【成片硬规则】禁止字幕、标题、姓名条、价格字、水印、背景音乐和人物介绍。",
    "【商品】无品牌折叠暖手宝。用户上传商品图锁定外观；未到取暖情境前不出现。",
    "",
    "## 人物与故事资料（仅供建资产，不得拍成人物介绍）",
    ...characters.map(([id, name, desc]) => `### ${id} ${name}\n- ${desc}`),
    "",
    "## 场景",
    ...scenes.map(([id, name, desc]) => `### ${id} ${name}\n- ${desc}`),
    "",
    "## 正式制作单元",
    ...shotBlocks
  ].join("\n\n");
}

function summarizeProject(project) {
  const manifest = project.script?.assetExtractionNormalization?.assetManifest || {};
  const props = (project.assetLibraries?.props || []).map(item => item.name);
  const wardrobes = (project.assetLibraries?.wardrobes || []).map(item => `${item.characterName || ""}:${item.name}`);
  const dialogue = (project.script?.sourceDialogueLedger || []).map(item => item.text);
  return {
    id: project.id,
    title: project.title,
    stage: project.currentStage,
    status: project.status,
    analysisMethod: project.script?.analysisMethod || "",
    detectedFormat: project.script?.detectedFormat || "",
    duration: project.generation?.durationContract || project.script?.durationContract || {},
    characters: (project.characters || []).map(item => ({ id: item.id, name: item.name })),
    scenes: (project.scenes || []).map(item => ({ id: item.id, name: item.name })),
    shots: (project.shots || []).length,
    shotSeconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    dialogueTurns: (project.script?.sourceDialogueLedger || []).length,
    coreProps: props,
    wardrobes,
    manifest,
    qualityAdvisory: project.script?.qualityAudit?.advisory === true,
    qualityFailures: (project.script?.qualityAudit?.advisoryFailures || project.script?.qualityAudit?.failures || []).slice(0, 12),
    sampleDialogue: dialogue.slice(0, 3)
  };
}

function auditAssets(label, project, expect) {
  const names = (list, key = "name") => (list || []).map(item => String(item[key] || item.name || "").trim());
  const characters = names(project.characters);
  const scenes = names(project.scenes);
  const props = names(project.assetLibraries?.props || []);
  const failures = [];
  for (const name of expect.characters) {
    if (!characters.includes(name)) failures.push(`缺人物：${name}`);
  }
  for (const name of expect.forbiddenCharacters || []) {
    if (characters.includes(name)) failures.push(`不该建人物：${name}`);
  }
  for (const name of expect.scenes) {
    if (!scenes.some(item => item.includes(name) || name.includes(item))) failures.push(`缺场景：${name}`);
  }
  for (const name of expect.coreProps) {
    if (!props.includes(name)) failures.push(`缺核心道具：${name}`);
  }
  for (const name of expect.forbiddenProps || []) {
    if (props.includes(name)) failures.push(`不该建道具：${name}`);
  }
  if ((project.shots || []).length < expect.minShots) failures.push(`分镜过少：${project.shots.length} < ${expect.minShots}`);
  const seconds = (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  if (seconds < 280 || seconds > 480) failures.push(`总时长不在5-8分钟：${seconds}秒`);
  return { label, ok: failures.length === 0, failures, characters, scenes, props, shots: project.shots.length, seconds };
}

function promptFlags(text) {
  const value = String(text || "");
  return {
    length: value.length,
    hasSubtitleBan: /禁止.*字幕|无字幕|不得.*字幕/.test(value),
    hasBgmBan: /禁止.*背景音乐|无背景音乐|N\/A|nonDiegeticMusicEn/.test(value),
    hasIntroBan: /人物介绍|故事简介|资产卡|三视图/.test(value),
    hasChineseDialogue: /[\u3400-\u9fff]{2,}/.test(value)
  };
}

async function analyzeCase(caseSpec, scriptText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `puream-script-probe-${caseSpec.id}-`));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  settings.generation.engine = "hailuo-h3";
  store.saveSettings(settings);
  const created = store.createProject(caseSpec.title, {
    inputMode: "manual",
    targetDurationSeconds: caseSpec.targetSeconds,
    videoProviderKind: "puream-hailuo-h3"
  });
  store.patchProject(created.id, {
    productionPlan: {
      ...(store.getProject(created.id).productionPlan || {}),
      inputMode: "manual",
      scriptHandling: "respect",
      scriptFormat: caseSpec.scriptFormat,
      scriptFormatConfirmed: true,
      commerceMode: caseSpec.product ? "natural" : "none"
    },
    generation: {
      ...(store.getProject(created.id).generation || {}),
      engine: "hailuo-h3",
      mode: "storyboard_sheet",
      aspectRatio: "9:16"
    },
    product: caseSpec.product || { name: "", description: "", sellingPoints: "" },
    script: { raw: scriptText, source: "probe", importedAt: new Date().toISOString() }
  });

  let paidTextCalls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async () => {
      paidTextCalls += 1;
      throw Object.assign(new Error("probe uses local-first analysis"), { code: "TEXT_PROVIDER_DISABLED" });
    }
  });

  const started = Date.now();
  const analyzed = await workflow.analyzeScript(created.id);
  const analyzeMs = Date.now() - started;
  const project = store.getProject(created.id);
  const assetAudit = auditAssets(caseSpec.id, project, caseSpec.expect);

  const characterPrompts = (project.characters || []).map(character => ({
    id: character.id,
    name: character.name,
    prompt: workflow.compileImagePrompt(project, settings, "character_sheet", character)
  }));
  const scenePrompts = (project.scenes || []).map(scene => ({
    id: scene.id,
    name: scene.name,
    prompt: workflow.compileImagePrompt(project, settings, "scene_asset", scene)
  }));
  const propPrompts = (project.assetLibraries?.props || []).map(prop => ({
    id: prop.id,
    name: prop.name,
    prompt: [
      fillTemplate(settings.prompts.propAsset, {
        assetName: prop.name,
        assetDescription: [prop.description, prop.causalRole, prop.purpose].filter(Boolean).join("；")
      }),
      `【核心道具】${prop.causalRole || prop.purpose || ""}`
    ].join("\n")
  }));
  const wardrobePrompts = (project.assetLibraries?.wardrobes || []).map(item => ({
    id: item.id,
    name: item.name,
    prompt: fillTemplate(settings.prompts.wardrobeAsset, {
      characterName: item.characterName || "",
      assetName: item.name,
      assetDescription: item.description || item.changeReason || "剧情换装"
    })
  }));

  const sampleShots = [];
  const shots = project.shots || [];
  const picks = [...new Set([0, Math.floor(shots.length / 2), shots.length - 1, shots.findIndex(item => item.productMention)])]
    .filter(index => index >= 0 && index < shots.length);
  for (const index of picks) {
    const shot = shots[index];
    let sheetPrompt = "";
    let sheetError = "";
    try {
      sheetPrompt = workflow.compileImagePrompt(project, settings, "storyboard_sheet", {
        ...shot,
        visibleCharacterNames: (shot.visibleCharacterIds || shot.characterIds || [])
          .map(id => project.characters.find(item => item.id === id)?.name || id)
      });
    } catch (error) {
      sheetError = error.message;
    }
    let videoPrompt = "";
    let videoError = "";
    try {
      await workflow.ensureHailuoPromptSpec(project.id, shot.id, "storyboard_sheet", settings);
      const fresh = store.getProject(project.id);
      const freshShot = fresh.shots.find(item => item.id === shot.id);
      videoPrompt = workflow.buildShotPrompt(fresh, settings, freshShot, "storyboard_sheet", {
        images: [],
        imageRoles: [],
        audios: [],
        videos: []
      });
    } catch (error) {
      videoError = `${error.code || ""} ${error.message}`.trim();
    }
    sampleShots.push({
      id: shot.id,
      duration: shot.duration,
      scene: shot.scene || shot.sceneName,
      productMention: Boolean(shot.productMention),
      dialogue: (shot.dialogueTurns || []).map(item => item.text || item.spokenText).filter(Boolean),
      sheetPrompt,
      sheetError,
      sheetFlags: promptFlags(sheetPrompt),
      videoPrompt,
      videoError,
      videoFlags: promptFlags(videoPrompt)
    });
  }

  const promptAudit = [];
  for (const item of characterPrompts) {
    if (!item.prompt.includes(item.name)) promptAudit.push(`人物提示词未锁定姓名：${item.name}`);
    if (!/#E9E9E9|#D9D9D9/.test(item.prompt)) promptAudit.push(`人物提示词缺少固定背景：${item.name}`);
  }
  for (const item of scenePrompts) {
    if (!/无人|空场景|四个角度都必须无人/.test(item.prompt)) promptAudit.push(`场景提示词未禁止人物：${item.name}`);
  }
  for (const item of propPrompts) {
    if (/人物|手部/.test(item.prompt) === false && !/禁止人物/.test(item.prompt)) {
      // prop template already bans people
    }
    if (!item.prompt.includes(item.name)) promptAudit.push(`道具提示词未锁定名称：${item.name}`);
  }
  for (const shot of sampleShots) {
    if (shot.sheetError) promptAudit.push(`${shot.id} 分镜合图失败：${shot.sheetError}`);
    if (shot.videoError) promptAudit.push(`${shot.id} 生视频提示词失败：${shot.videoError}`);
    for (const line of shot.dialogue) {
      if (shot.videoPrompt && !shot.videoPrompt.includes(line) && !shot.videoError) {
        promptAudit.push(`${shot.id} 视频提示词缺少原句：${line}`);
      }
    }
    if (shot.sheetPrompt && /说：“/.test(shot.sheetPrompt)) promptAudit.push(`${shot.id} 分镜合图不应写入台词字幕`);
  }

  return {
    root,
    paidTextCalls,
    analyzeMs,
    preflight: {
      detectedFormat: detectFormat(scriptText),
      timedParsed: Boolean(parseTimedStoryboardScript(scriptText)),
      structuredParsed: Boolean(parseStructuredProductionScript(scriptText)),
      localDialogue: parseLedger(scriptText).length,
      localScenes: buildSourceSceneLedger(scriptText).catalogue?.map(item => item.name) || [],
      estimated: estimateUploadedScriptDuration(scriptText, parseLedger(scriptText), "puream-hailuo-h3", { engine: "hailuo-h3" })
    },
    project: summarizeProject(project),
    assetAudit,
    promptAudit,
    characterPrompts,
    scenePrompts,
    propPrompts,
    wardrobePrompts,
    sampleShots
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const scripts = [
    {
      id: "A-dialogue-family",
      title: "探针A《房产证》家庭对白稿",
      file: "01-家庭对白稿-房产证.txt",
      scriptFormat: "dialogue",
      targetSeconds: 330,
      type: "家庭误会清算",
      formatLabel: "极简对白稿 + 【场景】",
      product: null,
      expect: {
        characters: ["周桂兰", "周宁", "周凯"],
        forbiddenCharacters: ["周宁丈夫"],
        scenes: ["老小区客厅", "老小区楼道", "银行大厅", "医院走廊", "周宁出租屋"],
        coreProps: ["房产证"],
        forbiddenProps: ["手机", "茶杯", "椅子"],
        minShots: 20
      },
      text: buildDialogueScript()
    },
    {
      id: "B-timed-workplace",
      title: "探针B《封口费》职场秒级分镜",
      file: "02-职场秒级分镜-封口费.txt",
      scriptFormat: "timed_storyboard",
      targetSeconds: 360,
      type: "职场证据反转",
      formatLabel: "幕/15秒分镜/对话汇总",
      product: null,
      expect: {
        characters: ["林夏", "赵衡", "陈姐"],
        scenes: ["开放办公区", "总监办公室", "地下车库", "会议室"],
        coreProps: ["录音笔", "离职协议"],
        forbiddenProps: ["电脑", "椅子", "水杯"],
        minShots: 20
      },
      text: buildTimedScript()
    },
    {
      id: "C-production-commerce",
      title: "探针C《留给远子取暖》带货制作稿",
      file: "03-带货制作稿-暖手宝.txt",
      scriptFormat: "production",
      targetSeconds: 420,
      type: "亲情带货",
      formatLabel: "### C/SC/S 完整制作稿",
      product: {
        name: "无品牌折叠暖手宝",
        description: "可折叠便携暖手宝，外壳浅灰，无品牌字。",
        sellingPoints: "捂手、便携、断电也能用一阵"
      },
      expect: {
        characters: ["苏妈", "苏远", "王婶"],
        scenes: ["苏妈厨房", "社区诊所走廊", "苏远出租屋", "社区小卖部"],
        coreProps: [],
        forbiddenProps: ["无品牌折叠暖手宝", "碗", "椅子", "手机"],
        minShots: 30
      },
      text: buildProductionScript()
    }
  ];

  const results = [];
  for (const item of scripts) {
    writeText(path.join(OUTPUT_ROOT, item.file), item.text);
    process.stdout.write(`analyzing ${item.id}...\n`);
    try {
      const result = await analyzeCase(item, item.text);
      const slimPrompts = {
        characters: result.characterPrompts.map(entry => ({ id: entry.id, name: entry.name, prompt: entry.prompt, flags: promptFlags(entry.prompt) })),
        scenes: result.scenePrompts.map(entry => ({ id: entry.id, name: entry.name, prompt: entry.prompt, flags: promptFlags(entry.prompt) })),
        props: result.propPrompts.map(entry => ({ id: entry.id, name: entry.name, prompt: entry.prompt, flags: promptFlags(entry.prompt) })),
        wardrobes: result.wardrobePrompts,
        samples: result.sampleShots
      };
      writeText(path.join(OUTPUT_ROOT, `${item.id}-prompts.json`), JSON.stringify(slimPrompts, null, 2));
      results.push({
        spec: {
          id: item.id,
          title: item.title,
          type: item.type,
          formatLabel: item.formatLabel,
          file: item.file,
          chars: item.text.length
        },
        paidTextCalls: result.paidTextCalls,
        analyzeMs: result.analyzeMs,
        preflight: result.preflight,
        project: result.project,
        assetAudit: result.assetAudit,
        promptAudit: result.promptAudit,
        promptCounts: {
          characters: result.characterPrompts.length,
          scenes: result.scenePrompts.length,
          props: result.propPrompts.length,
          wardrobes: result.wardrobePrompts.length,
          sampledShots: result.sampleShots.length
        }
      });
    } catch (error) {
      results.push({
        spec: {
          id: item.id,
          title: item.title,
          type: item.type,
          formatLabel: item.formatLabel,
          file: item.file,
          chars: item.text.length
        },
        paidTextCalls: 0,
        analyzeMs: 0,
        preflight: {
          detectedFormat: detectFormat(item.text),
          timedParsed: Boolean(parseTimedStoryboardScript(item.text)),
          structuredParsed: Boolean(parseStructuredProductionScript(item.text)),
          localDialogue: parseLedger(item.text).length,
          localScenes: buildSourceSceneLedger(item.text).catalogue?.map(entry => entry.name) || [],
          estimated: {}
        },
        project: {
          analysisMethod: "",
          characters: [],
          scenes: [],
          shots: 0,
          shotSeconds: 0,
          coreProps: [],
          wardrobes: [],
          manifest: {},
          stage: "failed",
          status: error.code || "ERROR"
        },
        assetAudit: { ok: false, failures: [`analyzeScript 抛错：${error.code || ""} ${error.message}`] },
        promptAudit: [`分析失败，未生成提示词：${error.message}`],
        promptCounts: { characters: 0, scenes: 0, props: 0, wardrobes: 0, sampledShots: 0 }
      });
    }
  }

  const report = [
    "# 三格式上传剧本资产拆解与提示词探针",
    "",
    `时间：${new Date().toISOString()}`,
    "系统：本机源码 0.16.11 / `WorkbenchWorkflow.analyzeScript` + `compileImagePrompt` + `ensureHailuoPromptSpec` + `buildShotPrompt`",
    "计费：文本/图片/视频付费接口均未成功调用。对话稿走本地优先拆镜；秒级分镜和制作稿走确定性解析。海螺视频提示词在关闭审核时用本地可执行稿。",
    "",
    "## 总表",
    "",
    "| 剧本 | 类型 | 格式 | 解析路径 | 人物 | 场景 | 核心道具 | 分镜/秒 | 资产拆解 | 提示词问题 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(item => `| ${item.spec.id} | ${item.spec.type} | ${item.spec.formatLabel} | ${item.project.analysisMethod || item.preflight.detectedFormat} | ${item.project.characters.map(c => c.name).join("、") || "无"} | ${item.project.scenes.map(s => s.name).join("、") || "无"} | ${item.project.coreProps.join("、") || "无"} | ${item.project.shots}/${item.project.shotSeconds}s | ${item.assetAudit.ok ? "通过" : item.assetAudit.failures.join("；")} | ${item.promptAudit.length ? item.promptAudit.join("；") : "抽样通过"} |`),
    "",
    ...results.flatMap(item => [
      `## ${item.spec.title}`,
      "",
      `- 文件：\`${item.spec.file}\``,
      `- 预检格式：${item.preflight.detectedFormat}；秒级解析=${item.preflight.timedParsed}；制作稿解析=${item.preflight.structuredParsed}`,
      `- 本地对白 ${item.preflight.localDialogue} 句，本地场景：${item.preflight.localScenes.join("、") || "无"}`,
      `- 分析耗时 ${item.analyzeMs}ms，付费文本请求 ${item.paidTextCalls}（对话稿会尝试 Agent，失败后回落本地）`,
      `- 阶段 ${item.project.stage}/${item.project.status}，方法 ${item.project.analysisMethod}`,
      `- 资产清单人物 ${item.project.manifest.characterCount || item.project.characters.length} / 场景 ${item.project.manifest.sceneCount || item.project.scenes.length} / 核心道具 ${item.project.coreProps.length} / 换装 ${item.project.wardrobes.length}`,
      `- 换装资产：${item.project.wardrobes.join("、") || "无"}`,
      item.assetAudit.failures.length ? `- 拆解缺口：${item.assetAudit.failures.join("；")}` : "- 拆解期望项全部命中",
      item.promptAudit.length ? `- 提示词缺口：${item.promptAudit.join("；")}` : "- 抽样提示词通过：人物锁名和灰底、场景无人、视频提示含原句、合图不写台词字幕",
      ""
    ]),
    "## 结论边界",
    "",
    "- 本探针验证的是 0.16.11 上传拆解合同和提示词编译器，不生成图片或视频，也不把本地稿当成付费成片验收。",
    "- 对话稿若要看 Agent 增强拆镜，需要另开付费文本任务。",
    "- 换装是否进资产库，取决于解析器是否写出 `wardrobeBindings`；源文有“换上”不等于一定建服装资产。"
  ].join("\n");

  writeText(path.join(OUTPUT_ROOT, "REPORT.md"), report);
  writeText(path.join(OUTPUT_ROOT, "summary.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`${report}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
