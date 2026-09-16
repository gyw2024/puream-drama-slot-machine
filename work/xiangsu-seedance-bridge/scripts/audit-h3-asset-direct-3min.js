"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, criticalPropContinuityLedger } = require("../app/workbench-workflow");

const OUTPUT_ROOT = path.resolve(process.argv[2]
  || path.join(process.cwd(), ".codex_tests", "TASK-20260827-DRAMA-H3-ASSET-DIRECT-001", "three-minute-prompt-chain"));
const BUDGET_CAPS = Object.freeze({ text: 5, image: 5, video: 10, total: 20 });

const characters = [
  { id: "C01", name: "苏梅", description: "52岁母亲，黑灰短发，深蓝针织衫，克制而有尊严", voiceDescription: "中低女声，温和克制，受辱时仍稳", signatureLine: "我不是怕老，我是不想让你替我低头。", promptOverrides: {} },
  { id: "C02", name: "林倩", description: "28岁新娘，米白便装，利落马尾，外柔内刚", voiceDescription: "清亮青年女声，情绪真挚，护母时坚定", signatureLine: "今天谁都不能拿我妈的白发羞辱她。", promptOverrides: {} },
  { id: "C03", name: "王琴", description: "53岁亲戚，墨绿套装，妆容精致，前期强势后期心虚", voiceDescription: "偏高女声，前期尖利，失势后发虚", signatureLine: "我只是替婚礼顾全体面。", promptOverrides: {} }
];

const scenes = [
  { id: "SC01", name: "婚纱店试衣区", description: "傍晚，暖白灯，镜墙与米色换鞋凳，试衣帘在画面左侧", promptOverrides: {} },
  { id: "SC02", name: "苏梅家洗手间", description: "夜晚，家用暖灯，洗手台、圆镜与干净毛巾，空间真实紧凑", promptOverrides: {} },
  { id: "SC03", name: "婚礼酒店休息厅", description: "次日午后，香槟色花艺与落地窗，宾客虚化，主桌入口清晰", promptOverrides: {} }
];

const props = [
  { id: "P01", name: "旧合照", description: "边角磨白的母女合照，是母亲多年付出的剧情证据", promptOverrides: {} },
  { id: "P02", name: "婚礼座位卡", description: "写有母亲姓名的烫金座位卡，是尊严冲突的核心物件", promptOverrides: {} }
];

const wardrobes = [
  { id: "W01", name: "苏梅深蓝礼服", characterId: "C01", characterName: "苏梅", description: "深蓝色正式礼服，端庄合体，婚礼当日从S09起持续穿着", changeReason: "婚礼正式出席", promptOverrides: {} }
];

const PRODUCT_SOURCE = process.env.DRAMA_ASSET_DIRECT_PRODUCT_IMAGE
  || "D:\\ai-cache\\USER-T~1\\codex-clipboard-80847316-e202-499b-bd11-7f015bfaf2fd.png";

const authored = [
  { scene: "SC01", action: "王琴一把抽走苏梅手里的主桌座位卡，反手拍在换鞋凳上。", before: "苏梅捏着座位卡站在林倩身边。", after: "座位卡落在凳上，苏梅的手停在半空。", props: [{ id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "", locationBefore: "苏梅手中", locationAfter: "换鞋凳上", stateBefore: "被苏梅捏住", stateAfter: "平放", transferAction: "王琴从苏梅手中抽走座位卡并反手拍到换鞋凳上" }], lines: [["C03", "满头白发也敢坐主桌？别把婚礼拍成敬老院！", "鄙夷地拔高音量，敬老院三字咬重", "冷笑挑眉", "抽卡后用指尖点向门外"], ["C02", "把卡还给我妈！", "压着怒火短促喝止，还字重落", "震惊转愤怒", "跨前一步挡在母亲身前"]] },
  { scene: "SC01", action: "林倩伸手去拿凳上的座位卡，王琴抢先从凳上抄起卡片侧身躲开；苏梅按住女儿手腕，王琴讥讽后又把卡片拍回原凳。", before: "座位卡留在换鞋凳上，林倩挡在苏梅前。", after: "座位卡重新平放在换鞋凳上；苏梅把女儿的手轻轻压下，自己退开半步。", props: [{ id: "P02", holderBeforeCharacterId: "", holderAfterCharacterId: "", locationBefore: "换鞋凳上", locationAfter: "换鞋凳上", stateBefore: "平放", stateAfter: "平放", transferAction: "王琴从凳上抄起座位卡，晃动后明确拍回同一张换鞋凳" }], lines: [["C01", "倩倩，别在你的婚礼前吵。", "低声劝住女儿，婚礼二字放轻", "受伤但克制", "按住女儿手腕后缓慢松开"], ["C03", "你妈都懂事，你还逞什么强？", "带胜意地轻嗤，懂事二字讥讽", "得意", "从凳上抄起座位卡晃一下，再拍回原凳"]] },
  { scene: "SC01", action: "苏梅手包开口处的旧合照先滑落到地面；苏梅立即弯腰把它捡回掌心，照片上年轻的她抱着年幼林倩；趁苏梅起身，林倩从换鞋凳取回座位卡，悄悄放进苏梅敞开的手包。", before: "旧合照露在苏梅手包开口处、即将滑落，座位卡仍平放在换鞋凳上。", after: "苏梅把从地面捡回的旧合照贴在掌心走向出口；座位卡已由林倩收进苏梅的手包。", props: [{ id: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅手包开口处", locationAfter: "苏梅掌心", stateBefore: "露出并即将滑落", stateAfter: "落地后被捡回", transferAction: "旧合照先从苏梅手包开口滑到地面，苏梅再弯腰把它捡回掌心" }, { id: "P02", holderBeforeCharacterId: "", holderAfterCharacterId: "C01", locationBefore: "换鞋凳上", locationAfter: "苏梅随身手包内", stateBefore: "平放", stateAfter: "妥善收进手包", transferAction: "林倩从换鞋凳取回座位卡并放进苏梅敞开的手包" }], lines: [["C01", "我先回去，明天我坐后排也一样看得见你。", "忍住哽咽平稳说完，后排二字略停", "委屈转体谅", "旧合照先从手包开口滑到地面；苏梅立即弯腰捡回掌心并挤出安慰的笑；同一时间林倩从凳上取回座位卡并放进苏梅手包"]] },
  { scene: "SC01", action: "林倩追到门口；苏梅站在门外，从窄门缝伸手轻轻按住林倩肩头并把她推回门内，随后才收手转身；苏梅始终把旧合照握在掌心，座位卡留在随身手包内。", before: "苏梅已跨出门，右手握着旧合照、肩上带着手包，林倩追来。", after: "苏梅已把林倩轻轻推回门内并收手，门缓慢合上；苏梅握着旧合照、带着装有座位卡的手包离开，林倩隔着玻璃看母亲走远。", props: [{ id: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅掌心", locationAfter: "苏梅掌心", stateBefore: "落地后被捡回", stateAfter: "随身握住", transferAction: "无换手；苏梅始终握着旧合照离开" }, { id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅随身手包内", locationAfter: "苏梅随身手包内", stateBefore: "妥善收进手包", stateAfter: "随身带走", transferAction: "无换手；座位卡继续留在苏梅随身手包内" }], lines: [["C02", "妈，你从来不是我的难堪。", "含泪急切喊住母亲，难堪二字坚定", "心疼", "双手抵门，目光追随母亲"], ["C01", "我知道，妈只是想让你今天顺顺利利。", "隔门温柔回应，尾音轻颤", "隐忍", "从门缝外轻轻按住林倩肩头把她推回门内，确认她站稳后收手，隔着玻璃点头再转身"]] },
  { scene: "SC02", action: "苏梅回家把掌心一直握着的旧合照立在镜边，镜中鬓角白发清晰；装有座位卡的随身手包放在她身侧。", before: "苏梅握着旧合照、带着装有座位卡的手包进入洗手间，灯刚亮。", after: "旧合照靠在镜框，座位卡仍收在苏梅随身手包内，苏梅直视自己的白发。", props: [{ id: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "", locationBefore: "苏梅掌心", locationAfter: "洗手间镜框边", stateBefore: "随身握住", stateAfter: "立放展示", transferAction: "苏梅把一直握在掌心的旧合照立在镜框边" }, { id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅随身手包内", locationAfter: "苏梅随身手包内", stateBefore: "随身带走", stateAfter: "保持收纳", transferAction: "无换手；座位卡继续留在苏梅随身手包内" }], lines: [["C01", "这些白发不是丢人，是我把女儿养大的日子。", "对镜自语，前半温柔，日子二字有力量", "释然", "握着旧合照、肩带装有座位卡的手包走进洗手间；把旧合照立到镜边，再以指腹抚过鬓角并触碰照片"]] },
  { scene: "SC02", action: "林倩赶回家，从母亲身后抱住她，把一盒七味堂植物泡泡染发膏放到洗手台。", before: "苏梅独自站在镜前。", after: "母女同框看向镜中，产品盒稳放台面。", product: true, lines: [["C02", "染不染都由你决定，我只想让你明天抬着头进门。", "贴近母亲耳边轻声说，抬着头三字温柔而坚定", "心疼转支持", "林倩走进洗手间，从身后抱住母亲，另一手把产品盒稳放洗手台"], ["C01", "那就让我为自己精神一次。", "笑中带泪，精神一次轻快上扬", "重新振作", "覆住女儿的手并点头"]] },
  { scene: "SC02", action: "林倩拆开一袋独立小包装，在掌心揉出细腻泡沫，先从苏梅发根与鬓角涂开。", before: "产品盒和独立袋放在洗手台。", after: "细腻泡沫均匀覆盖两侧发根，衣领保持干净。", product: true, lines: [["C02", "一袋按需用，像洗头一样揉开，鬓角和发根也能照顾到。", "边操作边清楚讲解，语速自然不推销", "专注", "戴手套拆开一袋独立装，在掌心揉出泡沫，再从鬓角向发根按摩涂匀"], ["C01", "这比我想的省事多了。", "惊喜地轻笑，省事二字放松", "意外安心", "看着镜中泡沫轻轻抬眉"]] },
  { scene: "SC02", action: "手机计时停在十八分钟，林倩替母亲冲洗擦干，苏梅的发色自然均匀。", before: "苏梅戴浴帽等待，计时接近结束。", after: "头发吹干，发根与鬓角自然盖色并有光泽。", product: true, lines: [["C02", "十八分钟到了，洗、染、护一次完成。", "看一眼计时后轻快提醒，三个动作分明", "期待", "停止计时并掀开浴帽"], ["C01", "颜色自然，连发根都匀了。", "对镜惊喜确认，发根二字稍重", "惊喜自信", "拨开鬓角检查后自然微笑"]] },
  { scene: "SC02", action: "苏梅换上深蓝礼服，林倩替她整理衣领；座位卡始终不取出并保持在手包内，苏梅只把镜边旧合照和洗手台上的一袋独立装依次收进同一只手包。", before: "吹风机停止；旧合照在镜框边，座位卡已在苏梅手包内，产品独立装在洗手台。", after: "旧合照和一袋独立装已加入苏梅随身手包，座位卡保持原位未被取出；母女并肩站直准备出门。", product: true, props: [{ id: "P01", holderBeforeCharacterId: "", holderAfterCharacterId: "C01", locationBefore: "洗手间镜框边", locationAfter: "苏梅随身手包内", stateBefore: "立放展示", stateAfter: "妥善收纳", transferAction: "苏梅从镜框边拿回旧合照并装进手包" }, { id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅随身手包内", locationAfter: "苏梅随身手包内", stateBefore: "保持收纳", stateAfter: "保持原位收纳", transferAction: "无取放动作；座位卡全程留在同一只手包内" }], lines: [["C01", "明天我不是去证明年轻，我是去拿回自己的座位。", "平静坚定，自己的座位逐字落稳", "自信", "苏梅换上深蓝礼服，林倩整理衣领；座位卡留在手包原位，苏梅只把旧合照和一袋独立装收进同一只手包"], ["C02", "我陪你一起。", "含笑回应，语气笃定", "欣慰", "挽住母亲手臂"]] },
  { scene: "SC03", action: "苏梅挽着林倩走进休息厅，肩上带着随身手包；王琴迎上来却一时没认出她，礼貌询问时座位卡仍在手包内。王琴说完后，苏梅才从手包取出自己的座位卡，停在主桌入口给王琴看并完整说出身份句；直到身份句句末，王琴才明确认出苏梅并僵住。", before: "王琴在主桌入口检查座位；座位卡和其余随身物品都在苏梅手包内。", after: "座位卡由苏梅清楚举在手中，其余随身物品仍在手包内；王琴已认出苏梅，笑容冻结、眼睛睁大。", props: [{ id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C01", locationBefore: "苏梅随身手包内", locationAfter: "苏梅手中", stateBefore: "保持原位收纳", stateAfter: "举起展示", transferAction: "王琴问完后，苏梅才从随身手包取出座位卡并举给王琴看" }], lines: [["C03", "请问您是新郎家的哪位贵客？", "热络而礼貌地试探，因一时认不出对方而略带疑惑", "礼貌疑惑", "苏梅挽着林倩走进休息厅，手包在苏梅肩上；王琴迎上两步，保持礼貌距离等候回答，座位卡仍在包内"], ["C01", "我是你昨晚嫌弃的那个白发亲家。", "从容直视，白发亲家轻轻反问式落下", "镇定", "王琴说完后，苏梅才取出并展示座位卡；苏梅完整说完身份句的句末，王琴才认出苏梅，随后笑容冻结、眼睛睁大"]] },
  { scene: "SC03", action: "苏梅把座位卡放到桌沿；王琴伸手想挪走，林倩先一步把手掌按在卡片旁边挡住她。", before: "座位卡仍在苏梅手中，三人站在主桌入口。", after: "座位卡留在桌沿并由林倩守住，王琴缩回手并避开母女目光。", props: [{ id: "P02", holderBeforeCharacterId: "C01", holderAfterCharacterId: "C02", locationBefore: "苏梅手中", locationAfter: "主桌桌沿、林倩手掌旁", stateBefore: "举起展示", stateAfter: "平放并被守住", transferAction: "苏梅把座位卡放到桌沿，林倩以手掌守住卡片并挡回王琴" }], lines: [["C02", "头发变了，我妈这些年受过的苦没变。", "克制陈述，苦字沉下去", "维护母亲", "苏梅先把卡放到桌沿；王琴伸手想挪走时，林倩抢先把手按在卡旁挡住她，另一手挽紧母亲"], ["C03", "我那是替婚礼顾全体面。", "急忙辩解，顾全体面越说越虚", "心虚", "被挡后收回手，视线躲开"]] },
  { scene: "SC03", action: "苏梅从随身手包取出旧合照，把它摆在桌沿座位卡旁，照片正面朝向王琴。", before: "座位卡由林倩守在桌沿；旧合照仍在苏梅随身手包内。", after: "旧合照与座位卡并排放在桌沿，王琴看清照片，林倩眼眶发红。", props: [{ id: "P01", holderBeforeCharacterId: "C01", holderAfterCharacterId: "", locationBefore: "苏梅随身手包内", locationAfter: "主桌桌沿", stateBefore: "妥善收纳", stateAfter: "正面展示", transferAction: "苏梅从随身手包取出旧合照并放到座位卡旁" }, { id: "P02", holderBeforeCharacterId: "C02", holderAfterCharacterId: "C02", locationBefore: "主桌桌沿、林倩手掌旁", locationAfter: "主桌桌沿、旧合照旁", stateBefore: "平放并被守住", stateAfter: "保持平放", transferAction: "无换手；座位卡始终留在桌沿" }], lines: [["C01", "真正的体面，是别把一个母亲熬白的岁月当笑话。", "不吼不叫却字字清楚，岁月和笑话形成重音", "尊严与释然", "从手包取出旧合照平稳放下，直视王琴"]] },
  { scene: "SC03", action: "王琴看一眼桌沿的旧合照和苏梅自然的发色，伸手把旁边的座位卡推回主位并摆正。", before: "旧合照与座位卡并排放在桌沿。", after: "旧合照仍留在桌沿，座位卡回到主位，王琴后退让路。", props: [{ id: "P01", holderBeforeCharacterId: "", holderAfterCharacterId: "", locationBefore: "主桌桌沿", locationAfter: "主桌桌沿", stateBefore: "正面展示", stateAfter: "保持展示", transferAction: "无换手；旧合照留在原处" }, { id: "P02", holderBeforeCharacterId: "C02", holderAfterCharacterId: "", locationBefore: "主桌桌沿、旧合照旁", locationAfter: "主桌主位", stateBefore: "保持平放", stateAfter: "摆正归位", transferAction: "王琴从桌沿把座位卡推回主位并双手摆正" }], lines: [["C03", "对不起，这个位置本来就该是你的。", "低声认错，不再辩解，本来二字带懊悔", "羞愧", "先看旧合照再看苏梅发色；把桌沿座位卡推回主位，双手摆正后退开让路"]] },
  { scene: "SC03", action: "林倩扶母亲在归位的座位卡旁坐下，近看母亲自然的发色；苏梅主动从随身手包取出此前装好的一袋独立装与女儿分享体验，并在说完后完整收回手包。", before: "座位卡已在主位，旧合照仍在桌沿；独立装仍在苏梅随身手包内。", after: "独立小袋已收回苏梅手包，座位卡与旧合照仍在桌上，母女相视一笑。", product: true, props: [{ id: "P01", holderBeforeCharacterId: "", holderAfterCharacterId: "", locationBefore: "主桌桌沿", locationAfter: "主桌桌沿", stateBefore: "保持展示", stateAfter: "保持展示", transferAction: "无换手；旧合照留在桌面" }, { id: "P02", holderBeforeCharacterId: "", holderAfterCharacterId: "", locationBefore: "主桌主位", locationAfter: "主桌主位", stateBefore: "摆正归位", stateAfter: "保持归位", transferAction: "无换手；座位卡保持在主位" }], lines: [["C01", "我用的是七味堂植物泡泡染发膏，自己在家像洗头一样就弄好了。", "自然分享亲身体验，语气轻松真诚", "松弛自信", "林倩扶苏梅在座位卡旁坐下并近看发色；苏梅从手包取出独立装展示，说完后完整收回手包"], ["C02", "一盒十袋，按需用，妈以后想什么时候精神就什么时候染。", "接话轻快，不催促购买", "开心", "替母亲理顺鬓角，含笑向母亲点头"]] },
  { scene: "SC03", action: "婚礼仪式正式开始，林倩牵着苏梅走向主桌中央，镜头从母女交握的手抬到笑脸。", before: "母女站在座位旁。", after: "两人在花艺前定格相拥，故事完整落点。", lines: [["C01", "女儿，妈今天最漂亮的不是头发，是终于没再低头。", "温柔感慨，没再低头坚定收尾", "释然幸福", "仪式开始，林倩牵苏梅走向主桌中央；苏梅握紧女儿的手，镜头从交握的手抬到两人笑脸"], ["C02", "你从来都不该低头。", "含泪微笑，轻声而坚定", "爱与骄傲", "靠近母亲并拥抱她"]] }
];

// Lossless English provider semantics for the deterministic, zero-charge audit
// fixture. Production asset-direct projects obtain the same fields in one
// batched text-model compile before the prompt-review dialog opens.
const semanticEn = [
  {
    action: "C03 abruptly snatches P02 from C01's hand and slaps P02 flat onto the shoe-changing bench.",
    before: "C01 stands beside C02 while pinching P02 between her fingers.",
    after: "P02 lies on the bench while C01's emptied hand remains suspended in midair.",
    lines: [
      ["Contemptuous raised volume; bite hard on the nursing-home insult, then finish at a controlled medium pace.", "C03 lifts one brow and holds a cold sneer with narrowed eyes.", "C03 snatches P02 from C01, slaps P02 onto the shoe-changing bench, then points one rigid finger toward the exit."],
      ["Compressed anger with a short sharp command; stress the demand to return it, speaking fast but fully articulated.", "C02's shock hardens into anger; brows draw down and jaw sets.", "C02 steps in front of C01 and squares her shoulders toward C03."]
    ]
  },
  {
    action: "C02 reaches toward P02 on the shoe-changing bench; C03 scoops P02 off the bench first and pivots sideways; C01 catches C02 by the wrist; after taunting C02, C03 visibly slaps P02 back onto the same bench.",
    before: "P02 lies flat on the shoe-changing bench while C02 stands protectively in front of C01.",
    after: "P02 lies flat on the same bench again; C01 gently presses C02's hand down, releases her wrist, and C01 herself steps back half a step.",
    lines: [
      ["Low restrained plea; soften the words about the wedding and finish evenly without losing the hurt.", "C01's eyes glisten, brows pinch briefly, and her jaw stays controlled.", "C02 reaches for P02; C01 catches and holds C02's wrist, then slowly loosens her fingers."],
      ["A smug quiet scoff; make the word sensible openly sarcastic at a natural pace.", "C03 shows a small victorious smirk and a self-satisfied raised brow.", "C03 scoops P02 off the bench, pivots away, gives it one taunting shake, then slaps P02 back onto the same bench." ]
    ]
  },
  {
    action: "C01 bends down and picks up P01 after it slips from her bag; while C01 rises, C02 retrieves P02 from the shoe-changing bench and quietly slips P02 into C01's open handbag; the physical photo depicts a younger C01 holding a child C02.",
    before: "P01 protrudes from the opening of C01's handbag and is about to slip while P02 remains flat on the shoe-changing bench.",
    after: "C01 presses the floor-retrieved P01 against her palm and walks toward the exit while P02 is secured inside C01's handbag.",
    lines: [["Suppress a sob and finish steadily; pause slightly on the back-row phrase.", "C01 forces a small reassuring smile through wet eyes and a trembling lower lid.", "P01 slips from C01's handbag to the floor; C01 bends down and picks it up while C02 moves P02 from the bench into C01's open handbag."]]
  },
  {
    action: "C02 catches up at the doorway; C01, already outside, keeps P01 in her palm and P02 inside her handbag while gently guiding C02 back through the narrow opening as the door closes between them.",
    before: "C01 has crossed the threshold holding P01 and carrying the handbag containing P02; C02 rushes toward the door.",
    after: "The door closes slowly; C01 leaves still holding P01 and carrying P02 inside her handbag while C02 watches from behind the glass.",
    lines: [
      ["Tearful urgent call; stress that C01 is never her embarrassment while keeping every word clear.", "C02's eyes brim, brows lift inward, and her breath catches visibly.", "C02 braces both hands on the door and keeps her gaze fixed on C01."],
      ["Gentle reply through the door with a slight tremble in the final syllables.", "C01 holds back tears, gives one tender nod, and lets her mouth soften.", "From outside the narrow doorway, C01 gently presses C02's shoulder and guides C02 back inside; after C02 regains balance, C01 releases her, nods through the glass, and only then turns away." ]
    ]
  },
  {
    action: "C01 returns home, props the P01 she has kept in her palm upright against the mirror, and studies the clearly visible gray hair at both temples; P02 remains secured inside her handbag.",
    before: "C01 enters the bathroom still holding P01 and carrying P02 inside her handbag; the light has just switched on.",
    after: "P01 rests against the mirror frame while P02 remains inside C01's handbag and C01 looks directly at her own gray temples.",
    lines: [["Private mirror monologue; begin warmly, then give firm weight to the years spent raising her daughter.", "C01's sadness settles into dignity; her eyes steady and her jaw lifts slightly.", "C01 enters the bathroom holding P01 and wearing the handbag containing P02; she props P01 against the mirror and brushes one gray temple."]]
  },
  {
    action: "C02 returns home, embraces C01 from behind, and sets the referenced product box firmly on the washbasin with her free hand.",
    before: "C01 stands alone facing the bathroom mirror.",
    after: "C01 and C02 share the mirror eyeline while the referenced product box remains stable and clearly visible on the washbasin.",
    lines: [
      ["Speak softly beside C01's ear; sound warm but resolute and stress entering with her head held high.", "C02's eyes soften with concern while her brows remain firm and protective.", "C02 enters the bathroom, hugs C01 from behind, and places the referenced product firmly on the washbasin."],
      ["Smile through tears; lift the final resolve lightly while keeping the sentence natural.", "C01's wet eyes brighten into a relieved smile and her cheeks release their tension.", "C01 covers C02's hand with her own and gives one clear nod." ]
    ]
  },
  {
    action: "C02 opens one individual product sachet, works it into fine foam between gloved palms, and spreads the foam evenly from C01's temples into the hair roots.",
    before: "The product box and one unopened sachet rest on the washbasin.",
    after: "Fine foam evenly covers both temple roots while C01's collar remains clean.",
    lines: [
      ["Explain clearly while working, at a natural non-sales pace with even volume.", "C02 keeps a focused, reassuring expression and checks coverage with attentive eyes.", "C02 opens one sachet, works it into foam in gloved palms, and massages it from both temples toward the roots."],
      ["Give a surprised light laugh and relax the stress on how easy it feels.", "C01 raises her brows in pleasant surprise and lets a genuine small smile appear.", "C01 watches the foam in the mirror and lightly lifts one brow." ]
    ]
  },
  {
    action: "C02 announces the completed wait and removes C01's shower cap; a chronological hard-cut time-compression montage shows rinsing, towel blotting and blow-drying; only after the hair is dry does C01 inspect the even roots in the mirror.",
    before: "C01 waits under a shower cap as the treatment nears completion.",
    after: "C01's hair is dry; roots and temples have even natural coverage and a healthy sheen.",
    dialogueWindows: [{ start: 0, end: 3.7 }, { start: 8.0, end: 10.6 }],
    segments: [
      { start: 0, end: 3.7, actionZh: "林倩停止等待并完整说完提醒台词，句末之后才掀开苏梅的浴帽；本段不提前冲洗。", cameraZh: "稳定中近景只拍林倩说话，台词期间不插入处理过程。", stateBeforeZh: "苏梅戴浴帽等待。", stateAfterZh: "苏梅的浴帽已摘下，露出的头发仍带染护泡沫。", actionEn: "C02 stops the wait, gives the complete reminder line, and removes C01's shower cap only after finishing the sentence.", cameraEn: "Stable medium close-up on C02; no process montage under the spoken line.", stateBeforeEn: "C01 waits under the shower cap.", stateAfterEn: "C01's shower cap is removed; the uncovered hair still carries the treatment.", soundEn: "Continuous bathroom room tone and synchronized cap movement." },
      { start: 3.7, end: 8.0, actionZh: "本段无对白，林倩替苏梅按时间顺序操作并硬切压缩：林倩用清水冲净苏梅发根泡沫，硬切林倩用毛巾吸干，硬切林倩用吹风机吹动苏梅头发，硬切到苏梅头发完全吹干且发色自然均匀。", cameraZh: "四个依次发生的过程特写硬切，不把完整流程伪装成实时连续动作。", stateBeforeZh: "苏梅的浴帽已摘下，露出的头发仍带染护泡沫。", stateAfterZh: "苏梅头发已冲净并完全吹干。", actionEn: "NO SPEECH. Chronological HARD-CUT TIME-COMPRESSION MONTAGE: C02 rinses foam from C01's roots; HARD CUT to C02 towel-blotting C01's hair; HARD CUT to C02 blow-drying C01's hair; HARD CUT to C01's fully dry, naturally even hair.", cameraEn: "Four clean chronological insert cuts; never show the full process as one continuous real-time action.", stateBeforeEn: "C01's shower cap is removed; the uncovered hair still carries the treatment.", stateAfterEn: "C01's hair is fully rinsed and dry.", soundEn: "Water rinse, towel movement and hair-dryer sound follow their matching inserts only." },
      { start: 8.0, end: 10.6, actionZh: "头发已经完全吹干后，苏梅拨开鬓角，在镜中检查均匀发根并完整说出反应台词。", cameraZh: "处理蒙太奇结束后硬切苏梅镜中近景。", stateBeforeZh: "苏梅头发已经完全吹干。", stateAfterZh: "苏梅确认发根均匀后露出自然笑容。", actionEn: "C01 parts the dry temple hair, inspects the even roots in the mirror, and delivers the complete reaction line.", cameraEn: "HARD CUT to C01's mirror close-up after the drying montage is complete.", stateBeforeEn: "C01's hair is already fully dry.", stateAfterEn: "C01 smiles after confirming the even roots.", soundEn: "Low bathroom room tone under C01's clean voice." },
      { start: 10.6, end: 12.0, actionZh: "本段无对白，保持干燥发根与鬓角的干净结果特写，再落到母女对镜放松反应；不重复冲洗、擦干或吹干。", cameraZh: "先拍结果特写，再稳定落到母女双人镜中构图。", stateBeforeZh: "苏梅刚确认完发色结果。", stateAfterZh: "干燥的发根与鬓角盖色自然均匀并带有健康光泽。", actionEn: "NO SPEECH. Hold a clean result close-up on the dry roots and temples, then settle on C01 and C02's relieved mirror reaction.", cameraEn: "Result insert followed by one stable two-person mirror composition.", stateBeforeEn: "C01 has just confirmed the result.", stateAfterEn: "C01's dry roots and temples show even natural coverage and healthy sheen.", soundEn: "Continuous low room tone; all mouths remain closed." }
    ],
    lines: [
      ["Give a light timely reminder; distinctly stress wash, color and care as three completed steps.", "C02 looks pleased and alert, with bright eyes and a quick confirming smile.", "C02 finishes the reminder first, then removes C01's shower cap; rinsing does not begin during this line."],
      ["Confirm with delighted surprise; give extra weight to the even roots.", "C01's eyes widen briefly, then settle into a confident natural smile.", "C01 parts the temple hair, inspects the roots in the mirror, and smiles." ]
    ]
  },
  {
    action: "C01 wears W01 while C02 straightens its collar; P02 stays untouched inside C01's handbag while C01 visibly packs P01 and one individual product sachet into that same handbag before the two women meet each other's eyes and smile.",
    before: "The hair dryer has stopped; P01 rests by the mirror, P02 is inside C01's handbag, and one product sachet rests on the washbasin.",
    after: "P01, P02 and one product sachet are visibly secured inside C01's handbag; C01 and C02 stand upright side by side ready to leave.",
    lines: [
      ["Calm, steady conviction; land each word of reclaiming her own seat deliberately.", "C01's shoulders square, eyes steady, and mouth forms a restrained confident smile.", "C01 changes into W01; C02 straightens its collar; P02 stays in C01's handbag while C01 packs P01 and one sachet into it."],
      ["Warm smiling answer with quiet certainty and no hesitation.", "C02's eyes brighten with relief and pride.", "C02 links her arm firmly through C01's arm." ]
    ]
  },
  {
    action: "C01 enters the hotel lounge arm in arm with C02 while carrying her handbag; C03 approaches and initially fails to recognize C01; C01 retrieves and shows P02 while giving her identity line; only at the line's end does C03 recognize C01 and freeze.",
    before: "C03 checks seating at the main-table entrance while P01, P02 and one product sachet remain inside C01's handbag.",
    after: "C01 holds P02 clearly in one hand while P01 and the product sachet remain inside her handbag; C03 has recognized C01, and C03's welcoming expression freezes.",
    lines: [
      ["Begin warmly and inquisitively with polite uncertainty because C03 does not yet recognize C01; keep the question courteous through its final word.", "C03 maintains a social smile with mildly puzzled eyes and no recognition reaction yet.", "C01 enters arm-in-arm with C02, her handbag on her shoulder; C03 approaches and waits politely while P02 stays inside."],
      ["Meet C03's gaze with composed calm and let the final identity phrase fall like a gentle question.", "C01 remains serene, chin level, with a small knowing firmness in her eyes.", "C01 retrieves and shows P02 while speaking; at the end of C01's identity line, C03 recognizes C01, then her smile freezes." ]
    ]
  },
  {
    action: "C01 places P02 at the table edge; C03 reaches to move P02 away, but C02 plants her hand beside P02 first and blocks C03's reach.",
    before: "C01 still holds P02 while C01, C02 and C03 stand at the main-table entrance.",
    after: "P02 remains at the table edge under C02's guard; C03 withdraws her hand and avoids C01 and C02's gaze.",
    lines: [
      ["Controlled factual statement; drop the pitch and weight firmly on the suffering C01 endured.", "C02's eyes stay hard and protective while her jaw tightens.", "C01 places P02 at the table edge; C03 reaches to move it, but C02 plants one hand beside P02 first and blocks C03."],
      ["Hasty defensive excuse; each repetition of preserving appearances grows weaker.", "C03's confidence collapses; her eyes evade C02 and her lips tense.", "After C02 blocks her, C03 withdraws her hand and looks away." ]
    ]
  },
  {
    action: "C01 retrieves P01 from her handbag and places P01 beside P02 with the photograph facing C03.",
    before: "P02 remains guarded at the table edge while P01 is still inside C01's handbag.",
    after: "P01 and P02 lie side by side at the table edge; C03 sees P01 clearly and C02's eyes fill with tears.",
    lines: [["Never shout; speak every word clearly and contrast the weight of years with the cruelty of treating them as a joke.", "C01's eyes remain steady and wounded but dignified; her jaw stays controlled.", "C01 retrieves P01 from her handbag, lays P01 down beside P02, and holds direct eye contact with C03."]]
  },
  {
    action: "C03 looks from P01 to C01's natural hair color, then pushes the adjacent P02 from the table edge back into its proper main-table position; P01 remains where C01 placed it.",
    before: "P01 and P02 lie side by side at the table edge.",
    after: "P01 remains displayed at the table edge, P02 is restored to the main-table place, and C03 steps backward to clear C01's path.",
    lines: [["Low sincere apology without argument; let regret weigh on the phrase that the place was always hers.", "C03's eyes lower, brows draw inward, and her mouth loses all defiance.", "C03 looks at P01 and C01's natural hair, pushes P02 from the table edge to its proper seat, squares it, and steps aside." ]]
  },
  {
    action: "C02 helps C01 sit beside the restored P02 while P01 remains displayed at the table edge; C02 looks closely at C01's natural hair color; C01 retrieves the packed product sachet, shows it while sharing her experience, then returns it fully to her handbag.",
    before: "P02 is restored to the main-table place, P01 remains displayed at the table edge, and the product sachet is still inside C01's handbag.",
    after: "The product sachet is fully returned to C01's handbag while P01 and P02 remain on the table and C01 and C02 exchange a relaxed smile.",
    lines: [
      ["Share a personal experience naturally with relaxed sincerity and no sales cadence.", "C01 appears calm and self-assured, with open eyes and an easy smile.", "C02 helps C01 sit and inspects her hair; C01 takes the sachet from her handbag, shows it, then returns it fully."],
      ["Join in lightly without urging a purchase; keep the final option playful and warm.", "C02 smiles openly with relieved happiness.", "C02 smooths C01's temple hair and gives C01 a warm nod." ]
    ]
  },
  {
    action: "The wedding ceremony visibly begins; C02 leads C01 toward the center of the main table as the camera rises from their clasped hands to their smiling faces.",
    before: "C01 and C02 stand beside the restored seat.",
    after: "C01 and C02 complete a warm embrace before the floral arrangement, closing the story.",
    lines: [
      ["Tender reflection; finish with firm dignity on never lowering her head again.", "C01 smiles through tears with relaxed brows and a newly lifted chin.", "The ceremony starts; C02 leads C01 toward the main-table center while C01 squeezes her hand; camera rises from clasped hands to both smiles."],
      ["Soft but unwavering answer through a tearful smile.", "C02's eyes glisten with love and pride while her smile stays steady.", "C02 moves close and embraces C01." ]
    ]
  }
];

// Explicit editorial listener ownership.  A silent listener still needs an
// identity reference and must never be guessed from character array order.
const listenerMatrix = [
  [["C01"], ["C03"]],
  [["C02"], ["C02"]],
  [["C02"]],
  [["C01"], ["C02"]],
  [[]],
  [["C01"], ["C02"]],
  [["C01"], ["C02"]],
  [["C01"], ["C02"]],
  [["C02"], ["C01"]],
  [["C01"], ["C03"]],
  [["C03"], ["C02"]],
  [["C03"]],
  [["C01"]],
  [["C02"], ["C01"]],
  [["C02"], ["C01"]]
];

function turnFor([speakerId, text, delivery, emotion, body], index, shotIndex) {
  const listenerIds = listenerMatrix[shotIndex]?.[index] || [];
  const translated = semanticEn[shotIndex]?.lines?.[index] || [];
  return {
    sourceDialogueId: `D${String(shotIndex * 2 + index + 1).padStart(3, "0")}`,
    speakerId,
    speaker: characters.find(item => item.id === speakerId)?.name || speakerId,
    listenerIds,
    text,
    delivery,
    emotionPeak: emotion,
    volume: /喝止|拔高|吼/.test(delivery) ? "偏高后收住" : "自然可辨",
    pace: /短促|急切|轻快/.test(delivery) ? "略快但咬字完整" : "中速，完整说完",
    stressWord: text.replace(/[，。？！]/g, "").slice(-4),
    breath: "起句前自然吸气，完整句中不抢断",
    body,
    deliveryEn: translated[0] || "",
    expressionEn: translated[1] || "",
    bodyEn: translated[2] || "",
    listenerBeat: "听者闭口并保持嘴唇静止，以眼神、停顿和身体反应承接",
    plannedSpeechSeconds: Math.min(5.4, Math.max(2.4, [...text].length / 4.6)),
    plannedAfterBeatSeconds: 0.6,
    onScreen: true
  };
}

function shotFor(item, index) {
  const dialogueTurns = item.lines.map((line, lineIndex) => turnFor(line, lineIndex, index));
  const translated = semanticEn[index] || {};
  if (Array.isArray(translated.dialogueWindows)) {
    dialogueTurns.forEach((turn, turnIndex) => {
      const window = translated.dialogueWindows[turnIndex];
      if (!window) return;
      turn.startSecond = Number(window.start);
      turn.endSecond = Number(window.end);
    });
  }
  // This fixture intentionally varies AI/editorial rhythm while keeping every
  // provider unit at least ten seconds. The five-shot cadence sums to 60s and
  // repeats three times for an exact three-minute story.
  const duration = [10, 11, 12, 13, 14][index % 5];
  const segment = duration / Math.max(1, dialogueTurns.length + 1);
  let subshots = dialogueTurns.map((turn, lineIndex) => ({
    start: Number((lineIndex * segment).toFixed(1)),
    end: Number(((lineIndex + 1) * segment).toFixed(1)),
    framing: `${turn.speaker}中近景`,
    camera: lineIndex === 0 ? "稳定前推到当前说话人" : "在换说话人处硬切反打",
    action: turn.body,
    actionEn: turn.bodyEn,
    cameraEn: lineIndex === 0 ? "Use a stable restrained push-in on the active speaker." : "HARD CUT at the speaker change to the new active speaker's reverse angle.",
    stateBeforeEn: lineIndex === 0 ? translated.before || "" : "",
    stateAfterEn: "",
    soundEn: "Continuous room tone with synchronized cloth, hand and object movement."
  }));
  subshots.push({
    start: Number((dialogueTurns.length * segment).toFixed(1)),
    end: duration,
    framing: "动作结果与听者反应近景",
    camera: "沿剧情因果落到物件或人物反应，再回到稳定完成态",
    action: `动作已经完成，稳定落到：${item.after}`,
    actionEn: `Do not replay the causal action; hold natural micro-motion while settling visibly into this completed state: ${translated.after || "the completed physical result"}`,
    cameraEn: "Hold a reaction or object-result close-up, then settle on the completed state.",
    stateBeforeEn: "",
    stateAfterEn: translated.after || "",
    soundEn: "Continuous room tone and the final synchronized settling sound."
  });
  if (Array.isArray(translated.segments) && translated.segments.length) {
    subshots = translated.segments.map((segment, segmentIndex) => {
      const localTurns = dialogueTurns.filter(turn => Number(turn.startSecond) >= Number(segment.start) - 0.001
        && Number(turn.startSecond) < Number(segment.end) - 0.001);
      for (const turn of localTurns) turn.subshotNumber = segmentIndex + 1;
      return {
        number: segmentIndex + 1,
        start: Number(segment.start),
        end: Number(segment.end),
        framing: "按当前动作主体的写实竖屏近景",
        camera: segment.cameraEn,
        action: segment.actionZh || segment.actionEn,
        actionZh: segment.actionZh || "",
        actionEn: segment.actionEn,
        camera: segment.cameraZh || segment.cameraEn,
        cameraZh: segment.cameraZh || "",
        cameraEn: segment.cameraEn,
        stateBefore: segment.stateBeforeZh || "",
        stateAfter: segment.stateAfterZh || "",
        stateBeforeZh: segment.stateBeforeZh || "",
        stateAfterZh: segment.stateAfterZh || "",
        stateBeforeEn: segment.stateBeforeEn || "",
        stateAfterEn: segment.stateAfterEn || "",
        soundEn: segment.soundEn || "",
        dialogueTurns: localTurns,
        sourceDialogueIds: localTurns.map(turn => turn.sourceDialogueId)
      };
    });
  }
  const present = [...new Set(item.lines.map(line => line[0]))];
  const propBindings = (Array.isArray(item.props) ? item.props : (item.prop ? [{ id: item.prop }] : [])).map(binding => ({
    propId: binding.id,
    holderBeforeCharacterId: String(binding.holderBeforeCharacterId || ""),
    holderAfterCharacterId: String(binding.holderAfterCharacterId || ""),
    holderCharacterId: String(binding.holderAfterCharacterId || binding.holderBeforeCharacterId || present[0] || ""),
    locationBefore: String(binding.locationBefore || ""),
    locationAfter: String(binding.locationAfter || ""),
    stateBefore: String(binding.stateBefore || item.before || ""),
    stateAfter: String(binding.stateAfter || item.after || ""),
    transferAction: String(binding.transferAction || "")
  }));
  return {
    id: `S${String(index + 1).padStart(2, "0")}`,
    number: index + 1,
    duration,
    sceneId: item.scene,
    sceneName: scenes.find(scene => scene.id === item.scene)?.name || item.scene,
    characterIds: present,
    visibleCharacterIds: present,
    videoReferenceCharacterIds: present,
    action: item.action,
    actionEn: translated.action || "",
    stateBefore: item.before,
    stateBeforeEn: translated.before || "",
    stateAfter: item.after,
    stateAfterEn: translated.after || "",
    visualReserveSeconds: Math.max(1.8, duration - dialogueTurns.reduce((sum, turn) => sum + turn.plannedSpeechSeconds + turn.plannedAfterBeatSeconds, 0)),
    durationRationale: "AI编排完整对白后保留动作结果、听者反应和自然运镜；整镜不少于10秒且不拆完整句。",
    productMention: item.product === true,
    propBindings,
    wardrobeBindings: index >= 8 ? [{ characterId: "C01", wardrobeId: "W01", continuity: "S09起换为婚礼礼服并持续到结尾" }] : [],
    dialogueTurns,
    subshots,
    providerTimedDirections: subshots.map(subshot => ({
      start: subshot.start,
      end: subshot.end,
      actionZh: subshot.actionZh || (/[^\x00-\x7F]/.test(String(subshot.action || "")) ? subshot.action : ""),
      cameraZh: subshot.cameraZh || (/[^\x00-\x7F]/.test(String(subshot.camera || "")) ? subshot.camera : ""),
      stateBeforeZh: subshot.stateBeforeZh || (/[^\x00-\x7F]/.test(String(subshot.stateBefore || "")) ? subshot.stateBefore : ""),
      stateAfterZh: subshot.stateAfterZh || (/[^\x00-\x7F]/.test(String(subshot.stateAfter || "")) ? subshot.stateAfter : ""),
      actionEn: subshot.actionEn,
      visualEn: subshot.actionEn,
      cameraEn: subshot.cameraEn,
      stateBeforeEn: subshot.stateBeforeEn,
      stateAfterEn: subshot.stateAfterEn,
      soundEn: subshot.soundEn
    })),
    promptOverrides: {}
  };
}

function countLiteral(haystack, needle) {
  return String(haystack || "").split(String(needle || "")).length - 1;
}

function promptSection(text, startLabel, nextLabel) {
  const source = String(text || "");
  const start = source.indexOf(startLabel);
  if (start < 0) return "";
  const bodyStart = start + startLabel.length;
  const end = nextLabel ? source.indexOf(nextLabel, bodyStart) : -1;
  return source.slice(bodyStart, end >= 0 ? end : undefined);
}

function normalizedRanges(text, pattern) {
  return [...String(text || "").matchAll(pattern)].map(match => [
    Number(match[1]).toFixed(1),
    Number(match[2]).toFixed(1)
  ]);
}

async function main() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  if (!fs.existsSync(PRODUCT_SOURCE)) throw new Error(`Uploaded product reference is missing: ${PRODUCT_SOURCE}`);
  const productReferencePath = path.join(OUTPUT_ROOT, "manual-product-reference.png");
  fs.copyFileSync(PRODUCT_SOURCE, productReferencePath);
  const dataRoot = path.join(OUTPUT_ROOT, "isolated-workbench");
  fs.rmSync(dataRoot, { recursive: true, force: true });
  const store = new WorkbenchStore(dataRoot);
  const created = store.createProject("H3资产直投三分钟全链路验收", {
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    inputMode: "manual",
    executionMode: "step",
    targetDurationSeconds: 180
  });
  const project = store.getProject(created.id);
  const shots = authored.map(shotFor);
  const ledger = shots.flatMap(shot => shot.dialogueTurns.map(turn => ({
    id: turn.sourceDialogueId,
    shotId: shot.id,
    speakerId: turn.speakerId,
    speaker: turn.speaker,
    text: turn.text
  })));
  const rawScript = authored.map((item, index) => `${index + 1}. ${item.action}\n${item.lines.map(line => `${characters.find(character => character.id === line[0]).name}：${line[1]}`).join("\n")}`).join("\n\n");
  Object.assign(project, {
    productionRevision: "h3-asset-direct-3min-v1",
    status: "analyzed",
    currentStage: "assets",
    characters,
    scenes,
    shots,
    assetLibraries: { props, wardrobes, voices: [] },
    product: {
      name: "七味堂植物泡泡染发膏",
      description: "居家泡泡染，白发自然盖色，洗染护三效合一，30ml×10袋独立包装",
      sellingPoints: "像洗头一样操作；细腻泡沫易涂匀发根与鬓角；植萃染护；建议停留15–20分钟",
      imagePath: productReferencePath,
      publicUrl: ""
    },
    script: {
      raw: rawScript,
      sourceFingerprint: crypto.createHash("sha256").update(rawScript).digest("hex"),
      sourceDialogueLedger: ledger
    }
  });
  project.generation = {
    ...project.generation,
    engine: "hailuo-h3",
    videoProviderKind: "puream-hailuo-h3",
    mode: "asset_direct",
    modeConfirmed: true,
    aspectRatio: "9:16",
    targetDurationSeconds: 180
  };
  project.productionPlan = {
    ...(project.productionPlan || {}),
    inputMode: "manual",
    executionMode: "step",
    scriptHandling: "respect",
    scriptFormat: "production",
    scriptFormatConfirmed: true,
    commerceMode: "natural"
  };
  const propContinuity = criticalPropContinuityLedger(project);
  assert.equal(propContinuity.length, props.length, "every declared core prop must have a continuity ledger");
  for (const propEntry of propContinuity) {
    assert.ok(propEntry.appearances.length >= 2, `${propEntry.propId} must be tracked across appearances`);
    for (let index = 1; index < propEntry.appearances.length; index += 1) {
      const previous = propEntry.appearances[index - 1];
      const current = propEntry.appearances[index];
      assert.equal(current.holderBeforeCharacterId, previous.holderAfterCharacterId, `${propEntry.propId} holder must flow ${previous.shotId}->${current.shotId}`);
      assert.equal(current.locationBefore, previous.locationAfter, `${propEntry.propId} location must flow ${previous.shotId}->${current.shotId}`);
      assert.equal(current.stateBefore, previous.stateAfter, `${propEntry.propId} state must flow ${previous.shotId}->${current.shotId}`);
      assert.ok(current.transferAction, `${propEntry.propId}/${current.shotId} must explicitly describe transfer or no-change continuity`);
    }
  }
  store.saveProject(project);

  let paidTextCalls = 0;
  let paidImageCalls = 0;
  let paidVideoCalls = 0;
  const bridge = new Proxy({}, { get: () => async () => { paidVideoCalls += 1; throw new Error("paid video boundary crossed during prompt audit"); } });
  const workflow = new WorkbenchWorkflow({ store, bridge, locateFfmpeg: () => "", stagingRoot: path.join(dataRoot, "staging") });
  workflow.generateText = async () => { paidTextCalls += 1; throw new Error("paid text boundary crossed during prompt audit"); };
  workflow._generateImageCandidateUnlocked = async () => { paidImageCalls += 1; throw new Error("paid image boundary crossed during prompt audit"); };

  const reviewed = await workflow.preparePromptReviewBundle(created.id, { autoApprove: false, compileProviderSemantics: false });
  const items = reviewed.promptReview?.items || [];
  const assetItems = items.filter(item => ["characters", "scenes", "objects"].includes(item.group));
  const videoItems = items.filter(item => item.group === "videos");
  const storyboardItems = items.filter(item => item.group === "storyboards" || /^storyboard_/.test(item.stage));

  assert.equal(reviewed.promptReview?.status, "ready");
  assert.equal(shots.reduce((sum, shot) => sum + shot.duration, 0), 180);
  assert.equal(shots.length, 15);
  assert.equal(shots.every(shot => shot.duration >= 10 && shot.duration <= 15), true);
  assert.equal(videoItems.length, shots.length);
  assert.equal(storyboardItems.length, 0);
  assert.equal(items.some(item => item.stage === "character_video"), false);
  assert.equal(assetItems.some(item => item.stage === "character_intro"), true);
  assert.equal(assetItems.some(item => item.stage === "character_voice"), true);
  assert.equal(assetItems.some(item => item.stage === "scene_asset"), true);
  assert.equal(assetItems.some(item => item.stage === "prop_asset"), true);
  assert.equal(assetItems.some(item => item.stage === "wardrobe_asset" && item.entityId === "W01"), true);
  assert.equal(fs.existsSync(reviewed.product?.imagePath || ""), true, "uploaded product image must exist before prompt approval");
  for (const character of characters) {
    const identityItem = assetItems.find(item => item.stage === "character_intro" && item.entityId === character.id);
    assert.ok(identityItem, `${character.id} identity prompt missing`);
    assert.doesNotMatch(identityItem.prompt, /以图1中角色|图1.*唯一身份/, `${character.id} initial identity must not depend on a nonexistent Picture 1`);
    assert.match(identityItem.prompt, /作为后续唯一身份和服装基准/);
  }
  for (const prop of props) {
    const propItem = assetItems.find(item => item.stage === "prop_asset" && item.entityId === prop.id);
    assert.ok(propItem, `${prop.id} prop prompt missing`);
    assert.match(propItem.prompt, /写实影视(?:实体照片)?道具资产图/);
    assert.match(propItem.prompt, new RegExp(prop.name));
    assert.doesNotMatch(propItem.prompt, /单张分镜关键帧|逐秒分镜|storyboard/i);
  }
  for (const scene of scenes) {
    const sceneItem = assetItems.find(item => item.stage === "scene_asset" && item.entityId === scene.id);
    assert.ok(sceneItem, `${scene.id} scene prompt missing`);
    assert.doesNotMatch(sceneItem.prompt, /宾客|客人|人群|围观者/);
  }

  const screenTextTerms = /字幕|字卡|屏幕文字|可读文字|伪文字|水印|subtitles?|captions?|on[- ]screen\s+text|screen\s+text|readable\s+text|watermarks?|title\s+cards?/i;
  for (const shot of shots) {
    const item = videoItems.find(entry => entry.entityId === shot.id);
    assert.ok(item, `${shot.id} video prompt missing`);
    assert.ok(String(item.prompt || "").length > 100, `${shot.id} execution prompt too short`);
    assert.ok(String(item.displayPrompt || "").length > 100, `${shot.id} Chinese display prompt too short`);
    assert.doesNotMatch(item.prompt, screenTextTerms, `${shot.id} must not prime screen-text concepts`);
    assert.doesNotMatch(item.displayPrompt, screenTextTerms, `${shot.id} display prompt must not prime screen-text concepts`);
    assert.match(item.prompt, /<Subject\s+\d+>/, `${shot.id} must bind visible identity references`);
    assert.match(item.prompt, /<Audio\s+\d+>/, `${shot.id} must bind exact speaker voice references`);
    assert.match(item.prompt, /mouth=/i, `${shot.id} must lock the speaking mouth`);
    assert.match(item.prompt, /visual_timeline:/i, `${shot.id} must carry a camera/action timeline`);
    assert.doesNotMatch(item.prompt, /advance the authored causal action|face\/body follow|emotionally specific Chinese delivery/i, `${shot.id} must not ship generic semantic placeholders`);
    if (shot.dialogueTurns.length > 1) assert.match(item.prompt, /hard cut|shot-reverse-shot/i, `${shot.id} speaker changes need explicit cuts`);
    for (const turn of shot.dialogueTurns) {
      assert.equal(countLiteral(item.prompt, turn.text), 1, `${shot.id}/${turn.sourceDialogueId} execution dialogue must appear exactly once`);
      assert.equal(countLiteral(item.displayPrompt, turn.text), 1, `${shot.id}/${turn.sourceDialogueId} Chinese dialogue must appear exactly once`);
      assert.ok(String(turn.delivery).length > 4 && String(turn.emotionPeak).length > 1 && String(turn.body).length > 4);
      assert.equal(item.prompt.includes(String(turn.expressionEn).slice(0, 24)), true, `${shot.id}/${turn.sourceDialogueId} exact visible expression missing`);
      assert.equal(item.prompt.includes(String(turn.bodyEn).slice(0, 24)), true, `${shot.id}/${turn.sourceDialogueId} exact body action missing`);
    }
    const reviewedShot = (reviewed.shots || []).find(candidate => candidate.id === shot.id) || shot;
    const plan = reviewedShot.promptReviewReferencePlan || {};
    assert.equal((plan.images || []).some(reference => /^storyboard_/.test(reference.type || "")), false);
    assert.equal((plan.videos || []).length, 0, `${shot.id} asset-direct mode must not depend on a previous video`);
    const characterReferences = new Set((plan.images || []).filter(reference => reference.type === "character").map(reference => reference.entityId));
    const requiredCharacterIds = new Set([
      ...shot.dialogueTurns.flatMap(turn => [turn.speakerId, ...(turn.listenerIds || [])]),
      ...characters.filter(character => [shot.action, shot.stateBefore, shot.stateAfter, ...shot.dialogueTurns.flatMap(turn => [turn.body, turn.listenerBeat])].join(" ").includes(character.name)).map(character => character.id)
    ].filter(Boolean));
    for (const characterId of requiredCharacterIds) {
      assert.equal(characterReferences.has(characterId), true, `${shot.id} must reference active character ${characterId}`);
    }
    if (shot.id === "S09") {
      assert.equal((plan.images || []).some(reference => reference.type === "prop" && reference.entityId === "P02"), true, "S09 must infer the existing seat-card asset from authored action metadata");
    }
    const nonDialogueDisplay = shot.dialogueTurns.reduce((text, turn) => text.split(turn.text).join(""), item.displayPrompt);
    assert.doesNotMatch(nonDialogueDisplay, /手机.{0,12}(?:分钟|秒)|计时.{0,12}(?:分钟|秒)|音乐响起|背景音乐|BGM/i, `${shot.id} visual directions must not prime display digits or music`);
    const displayDialogueSection = promptSection(item.displayPrompt, "逐秒对白、说话人和口型：", "画面与切镜时间线：");
    const displayDialogueRanges = normalizedRanges(displayDialogueSection.split("\n").filter(line => line.includes("逐字对白")).join("\n"), /(\d+(?:\.\d+)?)—(\d+(?:\.\d+)?)秒/g);
    const executionDialogueRanges = normalizedRanges(item.prompt, /(?:^|\n)(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)s speaker=/g);
    assert.deepEqual(displayDialogueRanges, executionDialogueRanges, `${shot.id} Chinese and execution dialogue windows must be identical`);
    const displayVisualSection = promptSection(item.displayPrompt, "画面与切镜时间线：", "连续性：");
    const displayVisualRanges = normalizedRanges(displayVisualSection, /(\d+(?:\.\d+)?)—(\d+(?:\.\d+)?)秒/g);
    const executionVisualSection = String(item.prompt || "").split("\n").find(line => line.startsWith("visual_timeline:")) || "";
    const executionVisualRanges = normalizedRanges(executionVisualSection, /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)s@V\d+/g);
    assert.deepEqual(displayVisualRanges, executionVisualRanges, `${shot.id} Chinese and execution visual-cut windows must be identical`);
  }
  const requiredPhysicalEvents = {
    S01: [/C03 snatches P02 from C01/i, /slaps P02 onto the shoe-changing bench/i],
    S02: [/C02 reaches for P02/i, /C03 scoops P02 off the bench/i, /slaps P02 back onto the same bench/i],
    S03: [/P01 slips from C01's handbag to the floor/i, /C01 bends down and picks it up/i, /C02 moves P02 from the bench into C01's open handbag/i],
    S04: [/C02 braces both hands on the door/i, /C01 gently presses C02's shoulder and guides C02 back inside/i, /C01 releases her/i],
    S05: [/C01 enters the bathroom holding P01/i, /handbag containing P02/i, /props P01 against the mirror/i],
    S06: [/C02 enters the bathroom, hugs C01/i, /places the referenced product firmly on the washbasin/i],
    S07: [/C02 opens one sachet/i, /works it into foam/i, /massages it from both temples toward the roots/i],
    S08: [/C02 rinses foam from C01's roots/i, /C02 towel-blotting C01's hair/i, /C02 blow-drying C01's hair/i],
    S09: [/C01 changes into W01/i, /C02 straightens its collar/i, /P02 stays in C01's handbag/i, /packs P01 and one sachet/i],
    S10: [/C01 enters arm-in-arm with C02/i, /handbag on her shoulder/i, /P02 stays inside/i, /C01 retrieves and shows P02 while speaking/i, /at the end of C01's identity line, C03 recognizes C01/i],
    S11: [/C01 places P02 at the table edge/i, /C03 reaches to move it/i, /C02 plants one hand beside P02 first and blocks C03/i],
    S12: [/C01 retrieves P01 from her handbag/i, /lays P01 down beside P02/i],
    S13: [/C03 looks at P01 and C01's natural hair/i, /pushes P02 from the table edge to its proper seat/i, /steps aside/i],
    S14: [/C02 helps C01 sit and inspects her hair/i, /C01 takes the sachet from her handbag/i, /returns it fully/i],
    S15: [/The ceremony starts/i, /C02 leads C01 toward the main-table center/i, /camera rises from clasped hands to both smiles/i, /C02 moves close and embraces C01/i]
  };
  for (const [shotId, patterns] of Object.entries(requiredPhysicalEvents)) {
    const prompt = videoItems.find(item => item.entityId === shotId)?.prompt || "";
    const visualTimeline = String(prompt).split("\n").find(line => line.startsWith("visual_timeline:")) || "";
    for (const pattern of patterns) {
      const flags = pattern.flags.includes("i") ? "gi" : "g";
      const occurrences = visualTimeline.match(new RegExp(pattern.source, flags)) || [];
      assert.equal(occurrences.length, 1, `${shotId} visual timeline must schedule ${pattern} exactly once`);
    }
  }
  const s02Prompt = videoItems.find(item => item.entityId === "S02")?.prompt || "";
  assert.doesNotMatch(s02Prompt, /the listener retreats a visible half-step/i, "S02 must not swap the authored retreating actor with the listener");
  assert.match(s02Prompt, /C01 gently presses C02's hand down/);
  assert.match(s02Prompt, /C03 scoops P02 off the bench/i, "S02 must show where C03 obtains P02");
  assert.match(s02Prompt, /slaps P02 back onto the same bench/i, "S02 must return P02 to the authored location");
  const s03Prompt = videoItems.find(item => item.entityId === "S03")?.prompt || "";
  assert.match(s03Prompt, /P01 slips from C01's handbag to the floor/i, "S03 must execute the fall before the pickup");
  assert.match(s03Prompt, /C01 bends down and picks it up/i, "S03 must execute the authored bend-and-pickup action");
  assert.match(s03Prompt, /C02 moves P02 from the bench into C01's open handbag/i, "S03 must show C02 retrieving and bagging P02");
  const s04Prompt = videoItems.find(item => item.entityId === "S04")?.prompt || "";
  assert.match(s04Prompt, /gently presses C02's shoulder and guides C02 back inside/i, "S04 must execute the authored doorway push before C01 leaves");
  const s06Prompt = videoItems.find(item => item.entityId === "S06")?.prompt || "";
  assert.match(s06Prompt, /C01 and C02 share the mirror eyeline.*product box remains stable/i);
  const s08Prompt = videoItems.find(item => item.entityId === "S08")?.prompt || "";
  assert.match(s08Prompt, /V2=NO SPEECH\. Chronological HARD-CUT TIME-COMPRESSION MONTAGE/i);
  assert.match(s08Prompt, /3\.7-8\.0s@V2/i);
  assert.match(s08Prompt, /8\.0-10\.6s speaker=C01/i);
  assert.match(s08Prompt, /C02 rinses foam[^\n]*C02 towel-blotting[^\n]*C02 blow-drying/i);
  const s08Display = videoItems.find(item => item.entityId === "S08")?.displayPrompt || "";
  assert.equal(countLiteral(s08Display, "林倩用清水冲净苏梅发根泡沫"), 1, "S08 Chinese timeline must schedule rinse exactly once");
  assert.equal(countLiteral(s08Display, "不重复冲洗、擦干或吹干"), 1, "S08 final hold must explicitly preserve the completed state once");
  const s09Prompt = videoItems.find(item => item.entityId === "S09")?.prompt || "";
  assert.match(s09Prompt, /P02 stays in C01's handbag while C01 packs P01 and one sachet/i, "S09 must keep P02 in place while packing the other carried items");
  assert.doesNotMatch(s09Prompt, /retrieves P02|lifts P02|takes P02/i, "S09 must not invent a redundant seat-card retrieval");
  const s10Prompt = videoItems.find(item => item.entityId === "S10")?.prompt || "";
  assert.match(s10Prompt, /P02 stays inside/i, "S10 opening question must occur before the card appears");
  assert.match(s10Prompt, /at the end of C01's identity line, C03 recognizes C01/i, "S10 must make recognition explicit only after the identity line");
  const s12Prompt = videoItems.find(item => item.entityId === "S12")?.prompt || "";
  assert.match(s12Prompt, /retrieves P01 from her handbag/i, "S12 must retrieve P01 before placing it");
  const s14Prompt = videoItems.find(item => item.entityId === "S14")?.prompt || "";
  assert.match(s14Prompt, /takes the sachet from her handbag, shows it, then returns it fully/i, "S14 must retrieve and return the sachet packed in S09");

  assert.equal(paidTextCalls + paidImageCalls + paidVideoCalls, 0);
  await assert.rejects(
    () => workflow.generateImageCandidate(created.id, "character_intro", "C01", "", { promptPrepared: true }),
    error => error?.code === "PROMPT_REVIEW_REQUIRED"
  );
  assert.equal(paidImageCalls, 0, "prompt gate must stop before the image provider");
  const approved = await workflow.confirmAllPromptReview(created.id);
  assert.equal(approved.promptReview?.status, "approved");
  assert.equal(approved.promptReview?.items?.every(item => item.status === "confirmed"), true);
  assert.equal(paidTextCalls + paidImageCalls + paidVideoCalls, 0);

  const promptReviewFingerprint = crypto.createHash("sha256").update(JSON.stringify((approved.promptReview.items || []).map(item => ({
    id: item.id,
    prompt: item.prompt,
    displayPrompt: item.displayPrompt
  })))).digest("hex").toUpperCase();

  const promptBundlePath = path.join(OUTPUT_ROOT, "h3-asset-direct-3min-prompts.json");
  const reportPath = path.join(OUTPUT_ROOT, "h3-asset-direct-3min-audit.json");
  fs.writeFileSync(promptBundlePath, `${JSON.stringify({
    projectId: approved.id,
    promptReviewFingerprint,
    mode: approved.generation.mode,
    durationSeconds: 180,
    items: approved.promptReview.items.map(item => ({
      id: item.id,
      order: item.order,
      group: item.group,
      stage: item.stage,
      entityId: item.entityId,
      label: item.label,
      displayPrompt: item.displayPrompt,
      executionPrompt: item.prompt,
      references: item.references || []
    }))
  }, null, 2)}\n`, "utf8");
  const report = {
    ok: true,
    createdAt: new Date().toISOString(),
    projectId: approved.id,
    promptReviewFingerprint,
    mode: "asset_direct",
    provider: "puream-hailuo-h3",
    durationSeconds: 180,
    shots: shots.length,
    minimumShotSeconds: Math.min(...shots.map(shot => shot.duration)),
    maximumShotSeconds: Math.max(...shots.map(shot => shot.duration)),
    dialogueLines: ledger.length,
    scenes: scenes.length,
    characters: characters.length,
    props: props.length,
    promptReview: approved.promptReview.counts,
    checks: {
      allPromptsConfirmedBeforeMedia: true,
      storyboardsGenerated: 0,
      characterVideosGenerated: 0,
      exactDialogueCoverage: true,
      speakerVoiceMouthBinding: true,
      emotionExpressionDeliveryActionComplete: true,
      everyShotMasterActionEventScheduledExactlyOnce: true,
      explicitSpeakerCuts: true,
      bilingualTimelineParity: true,
      screenTextTermsAbsent: true,
      mediaCallsBeforeApproval: 0
    },
    budget: {
      capsYuan: BUDGET_CAPS,
      spentYuan: { text: 0, image: 0, video: 0, total: 0 },
      paidCalls: { text: paidTextCalls, image: paidImageCalls, video: paidVideoCalls },
      boundary: "offline prompt-chain acceptance only; real paid calls require a separate quote preflight"
    },
    promptBundlePath
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, promptBundlePath, summary: report }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "H3_ASSET_DIRECT_3MIN_AUDIT_FAILED", message: error.message, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 1;
});
