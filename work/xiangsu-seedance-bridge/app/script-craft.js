"use strict";

/**
 * Source writing crafts for PureAM short drama.
 * v23 (K3): harden storyCore enforcement, ban zero-cost misunderstanding arcs,
 * eyeline-to-listener (not camera); audio is bed+SFX only (no BGM/underscore).
 */

const ESCALATION_VARIABLES = Object.freeze([
  "公开羞辱",
  "抽走资源",
  "堵退路",
  "否定或抢夺物证",
  "站队撕裂",
  "时间压力",
  "当众定性",
  "撕毁善意证据"
]);

function storyDensityTargets(totalSeconds = 300, unitCount = 0) {
  const seconds = Math.max(60, Math.round(Number(totalSeconds) || 300));
  const units = Math.max(6, Math.round(Number(unitCount) || seconds / 10));
  const sceneMin = seconds < 180 ? 2 : Math.max(3, Math.ceil(seconds / 120));
  return {
    sceneMin,
    sceneMax: Math.min(8, sceneMin + (seconds >= 600 ? 3 : 2)),
    escalationMin: Math.max(4, Math.floor(units / 5)),
    costlyKindnessMin: Math.max(1, Math.round(units / 15)),
    payoffMin: Math.max(2, Math.round(units / 20))
  };
}

function productAliasBanList(productName = "") {
  const name = String(productName || "").trim();
  if (!name) return [];
  const aliases = [name];
  const stripped = name.replace(/硅胶|医用|老人|中老年|加厚|保暖|运动|智能|多功能|便携|家用|纯棉|实木|天然/g, "").trim();
  if (stripped.length >= 2) aliases.push(stripped);
  if (/护膝/.test(name)) aliases.push("护膝", "硅胶护膝", "膝盖护具");
  if (/护腰/.test(name)) aliases.push("护腰", "腰带", "腰部护具");
  if (/护踝/.test(name)) aliases.push("护踝", "脚踝护具");
  if (/茶盘/.test(name)) aliases.push("茶盘", "托盘");
  if (/按摩/.test(name)) aliases.push("按摩器", "按摩仪", "理疗仪");
  if (/枕/.test(name)) aliases.push("枕头", "枕芯");
  return [...new Set(aliases.filter(item => String(item || "").length >= 2))];
}

function misunderstandingArcBan() {
  return `【K3·误会和解型一票否决】
禁止「纯误会→发现纸条→一句对不起→和解」零代价翻篇。
即使选题是误会，也必须同时满足：
① antagonistLogic：有承担现实伤害的过错方，其伤害动机是利益计算，不能只是「后来才知道真相的好人」；
② costAfterReversal：反转瞬间过错方失去现实东西（面子/钱/居住权/站队/把柄），失语脸红不算；
③ 打脸或行动清算：至少一次五拍打脸或等价可见行动清算，禁止只靠道歉翻篇；
④ 禁止同一证据事件拍两遍（拆信/撕信/翻护膝不得在前后半段各演一次）。
选题/圣经/蓝图/终审任一环节缺以上四条 → hardFailure。`;
}

function eyelineConversationCraft() {
  return `【对视说话·视线轴硬规则·全模式全局】
人物对话时必须「对着人说话」，禁止「对着镜头/虚空念词」。
硬规则：
1. 说话人眼球与面部朝向听者（或听者所在屏幕方向），禁止正脸长时间直视镜头念台词（口播广告除外且本剧禁止口播）。
2. 对话链默认正反打 / 过肩（OTS）/ 中近景；关系镜建立站位后，说话切说话人，听完必须给听者反应镜。
3. 每个有对白的 subshot 必须写清：speakerFacing（朝向谁）／listenerFacing（听者是否看说话人）／eyeline（左↔右屏幕方向）／shotType（OTS/正反打/关系镜/反应镜）。
4. 多人场面先建立 scenePresence；当前生成单元仍只拍0–2人。第三人侧听、见证、插话或改口必须拆成相邻单人反应/入场单元，禁止挤进同一H3画面。
5. 图像/视频提示词必须显式写出英文或中文约束：looks at the listener's eyes / never addresses the camera。
6.  continuityAudit / qualityReview：出现「正脸对镜念词、眼神漂出画外、说话人与听者视线互不交接」→ 必须重抽。`;
}

function generationPhysicsCraft() {
  return `【K3·生成物理上限·提示词必须写对职责】
1. 视频模型一次生成=一个连续单元（合同内 5–15 秒可变，按时长与节拍定，不是全片锁死10秒）。提示词里写「1.5–3秒一切」不能指望模型在单元内真切碎；subshots 的定位是【后期剪辑蓝图】，不是「模型会自动硬切」。
2. 每个生成单元只承担 1 条连续动作链（一个 visualBeat），禁止单元内堆互不相关事件。
3. 【引擎分流·声音】
   · 海螺 H3：默认「提示词一把做混音」——每个单元必须生成可听的 bed+同步SFX；禁止干声对白、禁止单元内空洞静音；non_diegetic_music 固定 N/A，禁止写 BGM/underscore/非叙事配乐。延续模式必须显式承接上一单元的底噪音色，首尾 0.3 秒不得掉声。
   · Seedance / 其他：仍以 bed+同步SFX 写满；跨单元底噪掉声时可用 postSoundMixSheet 兜底补 bed/SFX，禁止补配乐。
4. 跨单元拼接缝无法靠“模型跨文件接唱”完美消除；海螺路径用「同场景延续底噪指令 + 单元头尾满声」把空洞压到最低，成片仍以静音占比≤1% 为闸。
5. 成片机器闸：静音占比＞1% 打回；成片平均镜头时长＞4 秒打回（按剪点统计）。`;
}

function postEditBlueprintCraft() {
  return `【后期剪辑蓝图 postEditCutlist·由 subshots 生成】
每个生成单元输出 editCutPoints（与 subshots 对齐）：
- cutAtSec：单元内切点秒（冲突段目标间隔 1.5–3 秒）
- cutType：硬切/动作匹配/视线匹配/正反打/反应插镜/物证插镜
- keepTake：从本单元素材保留的起止秒
- reorderHint：对话链是否需要与相邻单元做正反打重组
- eyeline：切后视线是否匹配
禁止把「冲突段1.5–3秒一切」只写在形容词里；必须落到 cutAtSec 数字。
后期剪辑清单生成器（postEditCutlist 提示词）负责把全片 subshots 汇总成可执行剪辑工单。`;
}

function hailuoInModelMixCraft() {
  return `【海螺H3·提示词一把混音·硬成功条件·仅 bed+SFX】
每个生成单元的英文声场必须让观众听出来，不是写了就算：
1. soundEn：连续环境底噪（具体：kitchen hood / living-room clock / street traffic / ward monitor）+ 每个可见动作的同步 SFX（落在秒点）。禁止写 BGM / underscore / score / soundtrack / non-diegetic music。
2. overallSoundscapeEn：覆盖整段 0.00→duration，中间不得掉成干声；同场景延续单元必须写 “continues the previous unit’s bed without dropout”。只写 bed+SFX。
3. nonDiegeticMusicEn：一律输出 N/A（官方六段字段保留，但本产品禁止背景音乐）。
4. 唯一例外：蓝图标记的全片唯一抽音静默单元，允许 0.5–1.5 秒只留呼吸/心跳，然后重声砸入。
5. 头尾保护：前 0.2 秒与后 0.3 秒必须有可听 bed 或同步 SFX，禁止淡出到死静音（除非本单元就是设计抽音点）。
6. 对白完整发声；无台词者不开口但要有听者反应气口；禁止多人同时张嘴抢同一声道。`;
}

function postSoundMixCraft() {
  return `【声场落地策略·海螺优先一把做 / 工单仅兜底·无配乐】
默认（海螺 H3）：在生成提示词里按 hailuoInModelMixCraft 一把写出 bed+SFX（无配乐），目标单镜可听、延续不断档；postSoundMixSheet 只在成片静音占比＞1% 时作为救稿/补混工单（只补 bed/SFX）。
Seedance 或其他引擎：生成阶段仍写满 soundCueSheet（bed/sfx，可保留 silenceDesign）；若跨单元掉声严重，再跑 postSoundMixSheet：
① 全片统一 bed 轨（堵拼接缝，交叉淡化 50–150ms）
② 按 cue 补同步 SFX 与反转前抽音
③ 禁止铺 BGM/underscore/非叙事配乐
④ 机器检测：静音占比≤1%。`;
}

function dialogueUnitMold(durationSeconds = 10) {
  const duration = Math.max(5, Math.min(15, Math.round(Number(durationSeconds) || 10)));
  const sentenceTarget = duration <= 7 ? 4 : (duration <= 12 ? 6 : 8);
  const charMin = Math.round(duration * 3.6);
  const charMax = Math.round(duration * 4.4);
  return `【${duration}秒对白因果模具】目标${sentenceTarget}句（轮）、${charMin}–${charMax}个可说汉字，末句必须在本镜结束前完整说完，并给反应/动作留约15%。
先写dialogueArc：entryCause（哪件刚发生的事实逼出首句）→speakerGoalA/B（双方此刻各要什么）→newInformation（本镜新增哪条信息）→exitConsequence（末句造成哪个可见动作或状态变化）。缺一项就不是有效对话。
只用1人递进独白或固定2人交锋：攻击/质问→防御/否认→反击/揭示→决定/落锤；每句必须改变信息、权力或行动，禁止同义复述、解释观众已看见的动作、空壳语气词和省略号顶戏。
恰好3个连续subshots：说话人近景→听者反应/反打→动作/物证/结果。逐句只写beat、delivery、body、listenerBeat；delivery合并情绪、音量、语速、重音和气口，禁止把同一表演拆成九个重复字段。`;
}

function dialogueWorkedExamples() {
  return `【新短剧素材对齐·字幕锤句正例】
女人：还把孩子吓哭了！
男人：现在连五十万缺口都来找你。
女人：连给你提鞋的资格都没有。
老人：建军回来了。
【对白正例·10秒六句节奏·可直接模仿】
王芳：你还敢瞒我？
李强：什么瞒不瞒的？
王芳：这张单谁签的？
李强：医院让签我就签。
王芳：你当我瞎？
李强：我没说你瞎，你别逼我。
【对白正例·带刺短句】
林妈：你敢当着全屋人说我贪你的钱？
阿杰：不是贪，是你自己乐意贴。
林妈：收据呢？
阿杰：丢了。
林妈：抽屉最底下那张呢？
阿杰：……你翻我东西？
【逐句情绪编译正例】
王芳：你还敢瞒我？｜intent=质问定调；emotion=压火→拔尖；volume=拔高；pace=抢半拍；stress=还敢；breath=句前吸气；body=上前半步盯李强眼睛；listenerBeat=李强眼神躲。
李强：医院让签我就签。｜intent=推诿；emotion=心虚→强撑；volume=压嗓；pace=拖长「签」字；stress=医院；breath=句尾泄气；body=别开脸但仍被王芳视线压住；listenerBeat=王芳冷笑。
【对白反例·禁止输出】
林妈：你怎么这样。
阿杰：……
林妈：我好心疼。
（反例问题：只有一两句、无交锋、情绪空、听不见撕扯、省略号顶戏）
【结构反例·禁止输出】
同一误会弧里「拆护膝见信撕信」演完一遍，后半段再拆再撕一遍；或全片只有「你装可怜→我错怪你了」无反派代价。`;
}

function performanceCraft() {
  return `【表演与感染力·源头必须写进 performance / emotion】
每个单元 emotion 写成「起点→爆点→落点」，禁止只写「愤怒」「难过」。
performance 必须写可见微表情与身体（对齐样片）：张嘴喊叫中、眉心死皱、泪光/红眼眶、双手攥车门/鸡蛋/文件、站着压跪着、护腹/后退/甩手。
对视：说话时盯听者眼睛/眉心，听者必须有愣神/冷笑/避开视线/手抖等反应；禁止木然对镜。
悲惨镜的身体执行：把泪憋回去（泪光在眼眶不掉比掉更狠）、手抖、扶墙、吞咽、笑一下撑不住。
打脸镜的身体执行：反派失态四选二写成可见动作（失语/声音破/后退/找补失败）；主角落锤时反而不吼，动作稳、眼神定。
对白不是念稿：要有抢话、打断、气口、音量顶格或突然压低。
反派按「假客气→利益算计→伤人真话→慌乱」递进；正派按「忍→问→爆→行动」递进，禁止全程同一种哭腔。`;
}

function audioCraft() {
  return `【声音设计 soundCueSheet·源头写满到秒点｜仅 bed+SFX｜海螺一把做】
每单元 audioPlan 升级为 soundCueSheet（bed/sfx，可保留 silenceDesign）：
①bed 环境底噪：具体内容（厨房抽油烟机/堂屋挂钟/街边车流/病房监护仪）+持续区间；换场必须换底噪；同场景相邻单元音色连续，头尾不得掉声。
②sfx 同步特效声：本单元每个可见动作逐一对位并写明秒点（第2秒摔门/第4秒撕纸/第6秒杯子磕桌/钱拍桌/拄拐触地/手机震动/抽泣吸气）。
③silenceDesign（可选）：全片恰一次抽音静默，落在主反转前2–5秒；底噪抽空 0.5–1.5 秒只留呼吸/心跳，静默后第一个声音必须重；其余单元禁止长静默。
禁止写 bgm / ducking / motifRecall / 背景音乐 / 低弦 / underscore；海螺编译时 nonDiegeticMusicEn 固定 N/A。
每个 subshot.sound 至少写「底噪+一种特效（秒点）」；海螺编译时落到英文 soundEn / overallSoundscapeEn，nonDiegeticMusicEn=N/A。`;
}

function productWindowCraft(productName = "", productEntryIndex = 0) {
  const name = String(productName || "商品").trim() || "商品";
  const bans = productAliasBanList(name).join("、") || name;
  const base = `【商品窗口源头规则·时间闸+品类自适应因果桥双闸】
时间闸：商品名、简称、俗称、旧款同类商品和用商品做出的动作，在窗口前一律不得出现（标题/对白/动作/visualBeat/subshots/图像提示词/视频提示词）。窗口前只铺与当前品类事实一致的生活情境，不得为了食品强造饥饿、为了百货强造疼痛或疾病。窗口开启条件：≥65%且晚于主反转。开场点名、展示、吃喝、穿戴、使用、摆放、开箱、清洁、收纳、送礼或争抢商品＝hardFailure。商品段按总时长动态占约10%–20%，不得绑定固定四镜或固定镜号。
因果闸 productCausalBridge 五桥，进入窗口必须写满至少三项：
①situationNeed 具体使用情境与真实需求，由商品事实决定，不得强造疼痛、饥饿、疾病或危机；
②whyNow 为什么此刻自然发生；
③action 符合品类的自然动作（吃/喝/穿戴/使用/摆放/开箱/清洁/收纳/送礼等）；
④observableOutcome 该品类可被镜头观察且合规的结果、体验或证据（食品可拍口感与分享反应，百货拍操作结果，服饰拍穿着变化），禁止医疗夸效和虚构；
⑤relationOrDecisionShift 商品动作后人物决定、关系或生活方式变化。
旧键 currentProblem/visibleEffect/relationShift 只作历史数据承载，不能把语义拉回固定疼痛、试戴模板。缺失即判硬广重写。禁止人物停下剧情面向镜头介绍、商品段超过全片20%、前后重复同一商品动作。整体/细节可连续但必须职责不同，随后立即进入真实使用、客观结果和受益者反应；商品价值由动作结果或剧情决定自然证明。`;
  return `${base}\n【本剧商品禁词】窗口前禁用：${bans}\n【商品窗口建议起始单元】第 ${Math.max(1, Number(productEntryIndex) || 1)} 单元起（仍须满足 ≥65% 且晚于主反转）。`;
}

function actBeatGrid(totalSeconds = 300, unitCount = 30) {
  const count = Math.max(1, Math.round(Number(unitCount) || 30));
  // This mirrors the percentage display used by the workflow only so the
  // writing guide never contradicts it. The workflow hard contract remains
  // the source of truth and validates both unit position and cumulative time.
  const latestWithPayoff = count >= 8 ? count - 3 : Math.max(0, count - 2);
  const reversalStartIndex = Math.min(latestWithPayoff, Math.max(0, Math.ceil(count * 0.65 - 0.5)));
  const reversalEndIndex = Math.max(reversalStartIndex, Math.min(latestWithPayoff, Math.floor(count * 0.8 - 0.5)));
  const preferredReversalIndex = Math.min(reversalEndIndex, Math.max(reversalStartIndex, Math.round(count * 0.72 - 0.5)));
  const shotId = index => `S${String(index + 1).padStart(2, "0")}`;
  const reversalWindow = `${shotId(reversalStartIndex)}–${shotId(reversalEndIndex)}`;
  const preferredReversal = shotId(preferredReversalIndex);
  const base = `【六幕拍点网格·按全片百分比展开（含内核锚点与声音设计）】
【合同优先级】本节只定义六幕剧情职责，不覆盖 workflow 的 mainReversalWindow / planBatchContractHints 动态镜号合同；实际批次必须服从 workflow 给出的镜号窗口与累计时长双重校验。
【唯一主反转】全片唯一 main_reversal 只能位于65%–80%，优选约72%；本剧 ${count} 单元的动态窗口为 ${reversalWindow}，优选 ${preferredReversal}。窗口外严禁提前揭底或拖后反转。
【机制先行】storyMechanism 只能选 rescue_repaid / kindness_misjudged / sacrifice_repaid / evidence_reversal 之一。前三类优先用“当事人/恩人已铺垫＋一个可见事实＋行动清算”，核心危机和善举要直接讲清，禁止故弄玄虚；只有 evidence_reversal 才要求 evidence1/evidence2、redHerring 和互证闭环。
幕1 0%–13% 钩子与代价建立：前8秒危机动作+带刺短句，开场主画面只拍危机主体和至多一个阻碍者；需要见证者时只在scenePresence预埋并另开相邻单人反应/入场镜。明确受损者/阻碍者/现实代价；themeObject首次出现（非商品名）；establish开场音色motif；对白密而可说完；商品禁。
幕2 13%–30% 变量加压A：至少2种不同加压变量且每次回指 storyCore.protagonistWound；让利益方的伤害动机变得可见；只有 evidence_reversal 才埋 redHerring；商品禁。
幕3 30%–50% 善意代价与证明铺垫：至少1次有成本善意（不可逆损失）；前三类机制铺当事人/恩人、承诺、物件或普通观众看得懂的事实，证据谜题才埋 evidence1/evidence2；继续密对白；商品禁。
幕4 50%–65% 加压与退路封死：换新变量加压并让善者付出更大现实代价；前三类机制允许观众看懂善者做了什么，只锁最终介入和清算，证据谜题只允许部分核验；不得写 main_reversal。
幕5 65%–83% 主反转与行动清算：在 workflow 动态窗口 ${reversalWindow} 内且优选 ${preferredReversal} 让已铺垫的当事人/恩人/事实生效；证据谜题在此完成互证，其他机制用一个可见事实即可。反转前2–5秒安排唯一抽音静默；随后用付钱/站队/归还/担责等行动落锤。商品仍须同时满足自身动态窗口且晚于反转。
幕6 83%–100% 回收结局：themeObject 回收+motif 音色回收；行动结果落地+主题收束；商品只承担价值落定后的自然生活行动；禁止口号独白、重复使用商品或重复道歉。`;
  return `【本剧时长合同】总时长 ${totalSeconds} 秒 / 约 ${count} 个生成单元。\n${base}`;
}

function planUnitDialogueGoal(durationSeconds = 10) {
  const duration = Math.max(5, Math.min(15, Math.round(Number(durationSeconds) || 10)));
  const sentenceTarget = duration <= 7 ? 4 : (duration <= 12 ? 6 : 8);
  const charMin = Math.round(duration * 3.6);
  const charMax = Math.round(duration * 4.4);
  return `${sentenceTarget}句（轮）、${charMin}–${charMax}个可说汉字；dialogueArc必须写entryCause/speakerGoalA/speakerGoalB/newInformation/exitConsequence；每句按attack/deflect/counter/reveal/decision之一推进，写合并delivery、body、listenerBeat；说话人看听者，末句必须在本镜结束前完整说完并造成可见后果`;
}

function storyCoreCraft() {
  return `【故事内核 storyCore 九问·先立内核再排戏】
1. valueStatement 替观众出的那口气。正例「老实人不该被当傻子」「养儿防老不该防出仇」；反例「家庭要和睦」（口号不是气）。
2. protagonistWound 旧伤口：一件具体往事+具体损失。正例「三年前卖房给弟弟凑彩礼，房本至今没她名」；反例「她心软」。
3. falseBelief 错误信念：主角坚信、观众前半段陪她一起信。正例「她信大儿媳再算计也是一家人」。
4. wantVsNeed：想要的（要回两万块）／需要的（承认识人不清、当众立边界）。
5. antagonistLogic 反派的利益计算。正例「弟弟认定姐姐的钱迟早是娘家的，不拿白不拿」；禁止「他就是坏」；禁止没有过错方的纯误会。
6. moralDilemma 两个选项都有真实代价。正例「当众揭穿=母亲手术没人签字；忍下=手术费被挪走」。
7. irreversibleChoice：第几幕、放弃了什么。正例「第4幕她把存折当众撕了，退路没了」。
8. themeObject 贯穿物件三现：开场受辱时出现→反转时变义→结局回收。正例「一篮土鸡蛋：开场被嫌脏→反转时揭出蛋底下压着借条→结局弟弟双手送回」。注意：themeObject 可以是非售卖道具；售卖商品不得充当开场钩子。
9. audienceFeeling：一个词。解气/心疼/释然。
硬规则：九问全部是名词+动词的具体事实，禁止形容词堆砌；此后每个节拍必须能回指至少一问，回指不上就删；antagonistLogic 或 audienceFeeling 答不出具体事实＝选题当场判死。

【使用位置】选题阶段出种子四问（valueStatement/protagonistWound/falseBelief/themeObject）+ 必须能答出 antagonistLogic 与 cost 雏形；故事圣经阶段出全九问；蓝图阶段逐节拍回指校验；终审阶段作为一票否决项。
【常见失败】把 valueStatement 写成口号；把 wound 写成性格；把 antagonistLogic 写成纯坏或缺失；themeObject 只出现一次或意义不变；纯误会零代价和解——以上全部判不合格重写。`;
}

function reversalMatrixCraft() {
  return `【自适应反转证明矩阵 reversalMatrix·先选机制再写所需证明】
storyMechanism四选一：rescue_repaid（救援受辱后获报）／kindness_misjudged（善意被误判后澄清）／sacrifice_repaid（牺牲被侵占后归还）／evidence_reversal（确有必要的证据谜题）。前三类优先，禁止所有题材都套查手机、账单、隐藏身份和红鲱鱼。
- audienceBelieves：观众在主反转前的明确判断；必须能用一句话复述，不能故意让观众完全看不懂。
- antagonistMisdirection：利益方用什么可见动作强化伤害或错误判断；不是随机撒谎。
- evidence1：所有机制都要有一个已铺垫、普通观众能看懂的可见事实/承诺/物件/行动。
- evidence2 与 redHerring：只有 evidence_reversal 必填；其他机制留空，禁止为了凑字段制造查证支线。
- reinterpretation：反转后至少一件已播事件改变意义；非谜题机制可由“原先被当成多管闲事→后来证明是救命”这类直接变义完成。
- costAfterReversal：过错方或主角承担什么现实结果；失语、脸红、后退和一句道歉不算行动代价。
硬规则：决定性当事人/恩人、物件或事实必须提前出现或被明确提及；主反转让已铺垫内容生效，不空降新信息。反转后立即给行动清算与可见好结局，不用半部戏重复解释。

【救援回报正例】开场老人砸窗救被困孩子并受伤→车主只看车损反咬索赔→孩子的呼吸、砸窗工具和围观者单人反应持续证明救援事实→已铺垫的孩子家属/有权处理者到场看见伤口和孩子状态→撤销索赔、承担医药费并公开道歉→老人得到实际补偿。这里不需要第二份文件、隐藏身份或红鲱鱼。
【证据谜题例外】只有当核心冲突本身无法由一个可见事实证明时，才设计evidence1/evidence2互证和一个redHerring；两证据单独都不构成真相，主反转才闭环。
【常见失败】简单善恶故事被改成连续查文件；恩人毫无铺垫突然空降；反转只靠口头解释；反派道歉后没有实际承担——全部重写。`;
}

function tragedyShotCraft() {
  return `【悲惨镜头语法库 tragedyShotCraft】
低谷单元 tragedy=true 至少选两种，写成可见镜头：
1. 物的控诉：空椅子/凉掉的饭/药盒/零钱/旧照片/洗旧的衣，插镜停留≥1秒，物比人先说话。
2. 身体证据：手抖、扶墙、吞咽、把眼泪憋回去（泪光在眼眶不掉比掉更狠）、笑一下撑不住。
3. 空间压迫：低机位仰拍施压者+俯拍主角；门框/窗框把主角框小；人群退开留主角孤身；长桌两端的距离。
4. 声音剥夺：环境底噪抽空0.5–1.5秒只留呼吸，再接一句轻声台词；或全场嘈杂中主角一句被淹没。
5. 现实代价：悲惨必须伴随不可逆损失（钱花出去/机会错过/话说出口收不回/签名落笔），只难过不失血不算悲惨。
禁止：连续两单元都是哭泣反应；旁白解释「他很惨」；只用环境声/特效声煽情而画面无代价。

【组合正例】低谷10秒单元：subshot1 物的控诉（桌上两副碗筷只动了一副，插镜1秒）；subshot2 身体证据（母亲把到眼眶的泪憋回去，手在桌下抖）；subshot3 声音剥夺（底噪抽空1秒只留呼吸，接一句轻声「没事，你们吃」）。全段无哭腔，观众自己破防。
【常见失败】连续三镜都是擦眼泪；用旁白/字幕告诉观众「她很苦」；声场拉满但画面里人物没有任何现实损失——判不合格重写。`;
}

function faceSlapShotCraft() {
  return `【打脸五拍剪辑段落 faceSlapShotCraft·禁止挤进单个H3镜头】
五拍是跨相邻生成单元完成的剪辑段落，不是要求一个单元同时塞进三四个人：
拍1 定性：反派与善者固定双人镜，反派给善者下结论；围观者只写入scenePresence，不入当前visible。
拍2 出示可见事实：纯物件/手部特写，或当事人单人举证；机制不是证据谜题时，一个普通观众能看懂的事实即可，禁止为了复杂强造第二证据。
拍3 见证反应：另开相邻单人反应镜，只拍一个见证人倒吸气、后退、改口或站队；不得把见证人挤进前一双人镜。
拍4 反派失态：切回反派单人近景，写出下颌、眼神、呼吸、声音破裂和找补失败中的至少两项。
拍5 行动落锤：善者或有权行动者单人/双人镜，以还钱、收回钥匙、扶走老人、报警、担责、公开站队等动作终结；关联themeObject或irreversibleChoice。
落锤后用一个结果镜展示权力、站队、资源或关系已改变，禁止只说“对不起”或让反派下一镜若无其事。

【三单元正例】单元A只拍反派↔善者完成定性与反击；单元B先给物件/手部特写，再切见证者单人反应；单元C先给反派单人失态，再以善者收回钥匙的动作落锤。每个单元仍严格0–2人、三段subshots、一个主动作链。
【常见失败】五拍压进一个多人关系全景；见证人抢主角口型；只有狠话没有可见事实；落锤靠嘴不靠行动；道歉注水替代清算——全部重写。`;
}

function dialogueEmotionCompiler() {
  return `【逐句对白编译 dialogueEmotionCompiler】
先锁dialogueArc：首句触发→双方目的→新增信息→末句可见后果。每句只输出四个表演字段：
beat：attack/deflect/counter/reveal/decision；
delivery：必须由当下情境逐句推导，写“起始情绪→峰值情绪＋语速＋音量/音高＋重音＋呼吸/哭腔/破音”，禁止全片复用“平静、中速、正常音量”；
body：说话人可见身体动作；listenerBeat：听者同步可见反应。
相邻句功能不得重复；双人交锋同一人不得连续超过2轮；不改变信息、权力或行动的句子删除。
逐句情境映射：赶人/护短/夺物时用急促高压、咬字重、音量拔高、鼻翼和下颌绷紧；受辱/委屈时用低音慢速、断续吸气、尾字发颤或哭腔，泪线和手抖同步；真相揭开后的懊悔用先失声、再破音、再哭着说完整短句，膝软或伸手又缩回；救人/危机时短促喘息、指令式重音。情绪必须随事件升级，不是每句都喊。
正例：王芳「你还敢瞒我？」｜beat=attack；delivery=压火起句→怒意爆开，语速快、重咬“瞒”、尾音拔高；body=攥单据逼近半步，下颌绷紧；listenerBeat=李强眼眶发红，吸气断一下。`;
}

function hookCraft() {
  return [
    "【开场钩子】前8秒必须是正在发生的危机动作+可见钩子道具+第一句6–12字带刺对白。普通观众不看简介也必须立即看懂四件事：谁和谁是什么关系、此刻发生什么危机/不公、冲突为什么现在爆发、不处理会失去什么。四件事用动作和双方短句说清，禁止靠旁白或后补长篇解释。",
    "若后续需要见证人，只在scenePresence预埋，并用下一相邻单人反应/入场镜建立；开场主镜仍只拍危机主体和至多一个阻碍者。",
    "钩子道具必须与售卖商品及其旧款同类品完全无关；开场点名、展示、穿戴、撕扯或争抢商品＝hardFailure。",
    "前60秒执行互动节奏：默认双人短句攻防或动作→回应→反应；连续两个生成单元不得都是同一人物独白。单人镜只允许1–3句短锤并同时完成救援、受伤、夺物、举证等可见动作，禁止五六句解释性独白。",
    "禁止站桩开场、独白开场、温吞解释开场、对镜头开场、先藏关系再让观众猜。"
  ].join("\n");
}

function escalationCraft() {
  return [
    "【加压升级】每30–60秒换变量：公开羞辱/抽资源/堵退路/抢证/撕站队/时间压力。",
    "加压必须回指 storyCore 伤口，不是随机变狠；观众要感到「更过分了」。",
    "禁止同义争吵复读、连续查文件、沉默高潮、同一证据事件重演两遍、省略号顶戏。"
  ].join("\n");
}

function scriptCraftGuide(options = {}) {
  const totalSeconds = Number(options.totalSeconds) || 300;
  const unitCount = Number(options.unitCount) || 30;
  const productName = String(options.productName || "").trim();
  const productEntryIndex = Number.isFinite(Number(options.productEntryIndex))
    ? Number(options.productEntryIndex)
    : Math.floor(unitCount * 0.65);
  const phase = String(options.phase || "full");
  const density = storyDensityTargets(totalSeconds, unitCount);
  const header = "【当前项目动态补充】这里只给本项目动态数值，不复述静态制作规则；冲突时以JSON Schema和以下数值为准。";
  const reversalStart = Math.max(1, Math.ceil(unitCount * 0.65));
  const reversalEnd = Math.max(reversalStart, Math.floor(unitCount * 0.8));
  const preferredReversal = Math.max(reversalStart, Math.min(reversalEnd, Math.round(unitCount * 0.72)));
  const timeline = `全剧${totalSeconds}秒、约${unitCount}个单元；0–8秒危机；每30–45秒引入一个新变量，约60秒兑现小结果；唯一主反转在累计65%–80%（约S${String(reversalStart).padStart(2, "0")}–S${String(reversalEnd).padStart(2, "0")}，优选S${String(preferredReversal).padStart(2, "0")}）。反转前必须让观众看懂危机、善举、代价和利益伤害。`;
  const productWindow = productName
    ? `商品“${productName}”仅在主反转后且累计≥65%进入（最早约S${String(productEntryIndex + 1).padStart(2, "0")}）；由剧情需求触发品类动作，再给客观结果和受益者反应。`
    : "本项目无商品时，不得凭空植入商品或广告口播。";
  if (phase === "story_bible") {
    return [
      header,
      timeline,
      productWindow,
      `主线必须可复述：危险/不公正在发生→善者立刻行动并付出代价→过错方因现实利益继续伤害→已铺垫的当事人/恩人/可见事实回来清算→善者得到行动好结局。先判断是救援回报、善意误判、牺牲被侵占还是确有必要的证据谜题；前三类禁止强塞查账、红鲱鱼和隐藏身份。本片动态密度：${density.sceneMin}–${density.sceneMax} 个各有新任务的场景、至少 ${density.escalationMin} 次不同变量加压、${density.costlyKindnessMin} 次有成本善意、${density.payoffMin} 次行动回收；单一场景不得过半。signatureLine为18–22个可说汉字，能用于5秒H3音色资产视频。`
    ].join("\n\n");
  }
  if (phase === "shot_plan") {
    return [
      header,
      timeline,
      productWindow,
      "只规划当前批并承接上一项stateAfter；每项给duration、dialogueGoal、dialogueArc、三段构图、声场和因果结果。dialogueArc必须说明首句触发、双方目的、新信息和末句造成的可见后果。scenePresence只管场内连续性，visibleCharacterIds严格0–2人；至少一半单人镜，第三人另开反应/入场镜。前60秒默认双人短句互动或动作-回应-反应，连续两个单元不得由同一人物独白；单人镜最多1–3句且必须伴随可见任务，禁止解释性长独白。填写focus/counterpart、shotFunction、sceneObjective、transitionReason；只输出本批JSON。",
      "对白容量：5–7秒4轮/18–31字，8–12秒6轮/29–53字，13–15秒8轮/47–66字；必须能完整说完。"
    ].join("\n\n");
  }
  if (phase === "units") {
    return [
      header,
      timeline,
      productWindow,
      "只写当前连续2项并沿用蓝图。先执行dialogueArc，再写逐句dialogueTurns：beat只选attack/deflect/counter/reveal/decision；delivery逐句写情绪起点→峰值、语速、音量/音高、重音和呼吸/哭腔/破音，禁止平声模板；body与listenerBeat写同步可见动作。每项恰好3个subshots；整镜只用蓝图0–2名visibleCharacterIds。顺序优先说话人近景→听者反应/反打→动作/物证/结果；每段只有一个主口型。前60秒不得连续两个单元由同一人物独白；单人镜最多1–3句短锤。",
      "emotionArc和performanceBeats必须从事件和人物立场推导，落到眉眼、下颌、泪线、呼吸、手指、重心与嗓音变化：赶人要气急压迫，受辱要委屈断气或哭腔，知恩后悔要失声→破音→哭着完成短句；情绪按冲突升级，禁止全员一直平静或无差别吼叫。切镜只由台词、视线、动作、物件、入场或声音驱动，尾帧保持微动作。商品按packshot/detail/use/result/reaction拆镜，整体/细节不出现无关人脸。",
      "容量：5–7秒4轮/18–31字，8–12秒6轮/29–53字，13–15秒8轮/47–66字；0秒附近开口，末句在结束前完整说完，并留约15%给反应与动作。H3英文提示由系统后编译，本阶段不输出hailuoPrompt。"
    ].join("\n\n");
  }
  return [
    header,
    timeline,
    productWindow,
    "先闭合因果和人物选择，再落每镜可见动作、可说完的密对白、对应声场与连续性；一次给出可生产结果，不依赖外审替你补剧情。"
  ].join("\n\n");
}

module.exports = {
  ESCALATION_VARIABLES,
  actBeatGrid,
  audioCraft,
  dialogueEmotionCompiler,
  dialogueUnitMold,
  dialogueWorkedExamples,
  eyelineConversationCraft,
  faceSlapShotCraft,
  generationPhysicsCraft,
  hailuoInModelMixCraft,
  misunderstandingArcBan,
  performanceCraft,
  postEditBlueprintCraft,
  postSoundMixCraft,
  productAliasBanList,
  productWindowCraft,
  planUnitDialogueGoal,
  reversalMatrixCraft,
  scriptCraftGuide,
  storyDensityTargets,
  storyCoreCraft,
  tragedyShotCraft
};
