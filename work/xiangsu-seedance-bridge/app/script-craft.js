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

const { dialogueUnitPrompt, sharedDramaWritingContract } = require("./drama-writing-contract");

function storyDensityTargets(totalSeconds = 300, unitCount = 0) {
  const seconds = Math.max(60, Math.round(Number(totalSeconds) || 300));
  const units = Math.max(6, Math.round(Number(unitCount) || seconds / 10));
  const sceneMin = seconds < 180 ? 2 : Math.max(3, Math.ceil(seconds / 120));
  return {
    sceneMin,
    // Total film duration is intentionally unbounded. Scene capacity grows with
    // the story instead of becoming impossible once sceneMin exceeds a fixed cap.
    sceneMax: sceneMin + Math.max(2, Math.ceil(seconds / 200)),
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

function eyelineConversationCraft(){return '【站位与发声】保留所有源稿人物与自然完整对白，不设置两人或两句上限。逐句明确真正听者（可以是群体、画外人、自言自语或授权购买引导中的观众），视线遵循交流和工作动作。站位、轴线、动作前后状态与唯一发声所有权一致；切镜按实际需要，不强制每次换人都切，不强制一直盯眼。';}

function generationPhysicsCraft(){return require('./production-content-requirements').INSTRUCTION+' 每镜按实际供应商时长范围执行完整连续剧情，源稿对白不得截断。没有固定平均镜头时长或静音比例门槛；由 Agent 审实际完整对白、无人声间隔和清晰可演性。';}

function postEditBlueprintCraft(){return '【剪辑蓝图】由 Agent 依据已批准的表演和因果动作给出必要切点、保留时段及衔接说明。切点按剧情需要，不强制每1.5–3秒切镜，不重排或截断完整台词；不得重放已执行的动作。';}

function hailuoInModelMixCraft(){return require('./production-content-requirements').INSTRUCTION+' 声场仅保留实际有依据的环境声与可听同步声，不强制每个动作配音效，不额外制造人声、片头杂音或背景音乐。实际画面和声音缺陷由 Agent 审核后定位修订。';}

function postSoundMixCraft(){return '【后期声音】由 Agent 根据实际媒体证据决定必要的环境声衔接和同步声修复；保留对白与声音身份，不重复叠加已存在音效，不按固定静音百分比返工，不强制反转前抽音或补配乐。';}

function dialogueUnitMold(durationSeconds = 10) {
  const duration = Math.max(10, Math.min(15, Math.round(Number(durationSeconds) || 12)));
  return `【${duration}秒 Agent 连续对白块模具】${dialogueUnitPrompt(duration, { solo: false })}，末句必须在本镜结束前完整说完，并按实际动作与完整语速安排必要余量。
先写dialogueArc：entryCause（哪件刚发生的事实逼出首句）→speakerGoalA（人物A要什么）→speakerGoalB（人物B要什么）→newInformation（本镜只新增哪条信息）→exitConsequence（末句造成哪个可见动作或状态变化）。缺一项就不是有效对话。
自然问答保留在同一Sxx：攻击/质问→否认/反击→揭示/落锤按剧情需要选择完整轮次，不先规定句数；每次speakerId变化都明确发声所有权，是否切镜由实际动作决定，上一人完整结束后停止发声。每句必须改变信息、权力或行动，禁止同义复述、解释观众已看见的动作、空壳语气词和省略号顶戏。逐句填写plannedSpeechSeconds/plannedAfterBeatSeconds，每镜填写visualReserveSeconds/durationRationale，禁止统一字/秒公式。
每个最终生成单元必须有dialogueTurns且按函数核算的时窗容纳完整台词，禁止纯动作或零对白生成单元。subshots按连续说话人轮次动态生成：同一说话人的相邻完整句合并，换speakerId才切新段；静默反应、动作建立、物证/商品插镜和动作结果只能并入首末对白段内部，禁止拆句、固定三段或增加无对白尾段。每段只允许当前mouthOwner开口并可沿180度轴线正反打。逐句只写beat、delivery、body、listenerBeat；delivery合并情绪、音量、语速、重音和气口。`;
}

function dialogueWorkedExamples() {
  return `【新短剧素材对齐·字幕锤句正例】
女人：还把孩子吓哭了！
男人：现在连五十万缺口都来找你。
女人：连给你提鞋的资格都没有。
老人：建军回来了。
【对白正例·同一Sxx内按轮次正反打·可直接模仿】
S01-T01 cameraOwner=王芳 mouthOwner=王芳：你还敢瞒我？这张单，谁签的？
S01-T02 cameraOwner=李强 mouthOwner=李强：医院让我签的。你别拿我当贼审。
S01-T03 cameraOwner=王芳 mouthOwner=王芳：那你看着我说，五十万去哪了？
S01-T04 cameraOwner=李强 mouthOwner=李强：钱没丢。是我不敢告诉你。
【对白正例·同一Sxx内带刺短句按说话人硬切】
S02-T01 cameraOwner=林妈 mouthOwner=林妈：你敢当着全屋人，说我贪你的钱？
S02-T02 cameraOwner=阿杰 mouthOwner=阿杰：不是贪，是你自己乐意贴。
S02-T03 cameraOwner=林妈 mouthOwner=林妈：收据呢？抽屉最底下那张呢？
S02-T04 cameraOwner=阿杰 mouthOwner=阿杰：你……翻我东西？
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
  const base = `【商品源头规则·共享带货编辑合同与品类事实因果链】
${require('./commerce-editorial-contract').POLICY}
因果闸 productCausalBridge 五桥，进入窗口必须写满至少三项：
①situationNeed 具体使用情境与真实需求，由商品事实决定，不得强造疼痛、饥饿、疾病或危机；
②whyNow 为什么此刻自然发生；
③action 符合品类的自然动作（吃/喝/穿戴/使用/摆放/开箱/清洁/收纳/送礼等）；
④observableOutcome 该品类可被镜头观察且合规的结果、体验或证据（食品可拍口感与分享反应，百货拍操作结果，服饰拍穿着变化），禁止医疗夸效和虚构；
⑤relationOrDecisionShift 商品动作后人物决定、关系或生活方式变化。
旧键 currentProblem/visibleEffect/relationShift 只作历史数据承载。需要、选品理由、真实特色解释、可见展示与人物决定必须有正文证据，不以字段齐全代替演绎。产品外观与使用事实保持用户原资料；不能凭空增添功能或开罐食用。`;
  return `${base}\n本剧商品：${name}。引出时机以真实需求和选品决定为准，不由固定镜号决定。`;
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
【合同优先级】以下六幕与百分比是可选结构参考，不限定事件数、反转镜号或每阶段长度；以用户要求和当前剧情为准。
【主反转】根据剧情因果、铺垫和结局兑现决定位置；65%–80%只是旧案例分布，不能作为镜号或时长审核门槛。
【机制先行】storyMechanism 只能选 rescue_repaid / kindness_misjudged / sacrifice_repaid / evidence_reversal 之一。前三类优先用“当事人/恩人已铺垫＋一个可见事实＋行动清算”，核心危机和善举要直接讲清，禁止故弄玄虚；只有 evidence_reversal 才要求 evidence1/evidence2、redHerring 和互证闭环。
幕1 0%–13% 钩子与代价建立：前8秒危机动作+带刺短句，开场主画面保留源稿必需的全部可见人物，需要见证者时明确其站位和入场依据。明确受损者/阻碍者/现实代价；themeObject依原稿首次出现；establish开场音色motif；对白密而可说完；商品顺序服从原稿及共享带货合同。
幕2 13%–30% 变量加压A：至少2种不同加压变量且每次回指 storyCore.protagonistWound；让利益方的伤害动机变得可见；只有 evidence_reversal 才埋 redHerring；商品顺序服从原稿及共享带货合同。
幕3 30%–50% 善意代价与证明铺垫：至少1次有成本善意（不可逆损失）；前三类机制铺当事人/恩人、承诺、物件或普通观众看得懂的事实，证据谜题才埋 evidence1/evidence2；继续密对白；商品顺序服从原稿及共享带货合同。
幕4 50%–65% 加压与退路封死：换新变量加压并让善者付出更大现实代价；前三类机制允许观众看懂善者做了什么，只锁最终介入和清算，证据谜题只允许部分核验；按实际剧情安排转折。
幕5 主反转与行动清算：让已铺垫的当事人、恩人或事实通过有动机的行动产生结果。商品出现与介绍依据原稿和具体需要。不得为了结构模板强行安排抽音静默。
幕6 83%–100% 回收结局：themeObject 回收+motif 音色回收；行动结果落地+主题收束；商品延续已有事实与剧情中的自然选择；禁止口号独白、重复使用商品或重复道歉。`;
  return `【本剧时长合同】总时长 ${totalSeconds} 秒 / 约 ${count} 个生成单元。\n${base}\n${require('./reference-parity-prompts').COMMERCE_SOURCE_POLICY}`;
}

function planUnitDialogueGoal(durationSeconds = 10) {
  return `${dialogueUnitPrompt(durationSeconds, { solo: false })}；一个Sxx保留完整源稿人物与自然问答，每次speakerId变化都明确发声所有权，不强制切镜；dialogueArc必须写entryCause/speakerGoalA/speakerGoalB/newInformation/exitConsequence；每句按attack/deflect/counter/reveal/decision之一推进，写合并delivery、body、listenerBeat；说话人看听者，末句必须在本镜结束前完整说完并造成可见后果`;
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
8. themeObject 贯穿物件三现：开场受辱时出现→反转时变义→结局回收。正例「一篮土鸡蛋：开场被嫌脏→反转时揭出蛋底下压着借条→结局弟弟双手送回」。注意：themeObject 可以是非售卖道具；售卖商品位置服从原稿及具体需求，不设置开场禁区。
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

【三单元正例】单元A只拍反派↔善者完成定性与反击；单元B先给物件/手部特写，再切见证者单人反应；单元C先给反派单人失态，再以善者收回钥匙的动作落锤。每个单元保留全部源稿可见人物、按连续说话人轮次动态subshots、一个主动作链。
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
  const header = "【当前项目动态补充】以下数值仅为规划示例；用户要求和原始事实优先，Agent按真实剧情安排，不作为数量或比例审核门槛。";
  const reversalStart = Math.max(1, Math.ceil(unitCount * 0.65));
  const reversalEnd = Math.max(reversalStart, Math.floor(unitCount * 0.8));
  const preferredReversal = Math.max(reversalStart, Math.min(reversalEnd, Math.round(unitCount * 0.72)));
  const timeline = `全剧目标${totalSeconds}秒、约${unitCount}个单元仅作规划参考；前8秒必须有核心冲突爆点；后续变量、结果、反转按实际因果和人物目的推进，不设固定出现频率或百分比闸门。`;
  const productWindow = productName
    ? `商品“${productName}”由真实需求和本商品选品理由引出；不机械锁定首次出现的百分位。${require('./commerce-editorial-contract').POLICY}`
    : "本项目无商品时，不得凭空植入商品或广告口播。";
  if (phase === "story_bible") {
    return [
      header,
      timeline,
      productWindow,
      `主线应可复述；人物行动、代价、冲突升级和结局回收由当前故事因果决定。场景数量、反转位置和同场时长没有固定配额。前8秒呈现与主线直接相关的强爆点。signatureLine只用于独立音色素材，应适合该素材实际时长，不新增到正片对白。`
    ].join("\n\n");
  }
  if (phase === "shot_plan") {
    return [
      header,
      timeline,
      productWindow,
      "只规划当前批并承接上一项stateAfter；每项给duration、dialogueGoal、dialogueArc、按连续说话人轮次动态构图、声场和因果结果。dialogueArc必须说明首句触发、双方目的、新信息和末句造成的可见后果。scenePresence只管场内连续性，visibleCharacterIds保留全部源稿可见人物；机位按剧情动机安排，第三人保留独立站位与闭口反应。前60秒默认双人短句互动或动作-回应-反应，连续两个单元不得由同一人物独白；单人镜最多1–3句且必须伴随可见任务，禁止解释性长独白。填写focus/counterpart、shotFunction、sceneObjective、transitionReason；只输出本批JSON。",
      sharedDramaWritingContract(totalSeconds)
    ].join("\n\n");
  }
  if (phase === "units") {
    return [
      header,
      timeline,
      productWindow,
      "只写当前连续2项并沿用蓝图。先执行dialogueArc，再写逐句dialogueTurns：每项必须有完整台词，禁止空表；beat只选attack/deflect/counter/reveal/decision；delivery逐句写情绪起点→峰值、语速、音量/音高、重音和呼吸/哭腔/破音，禁止平声模板；body与listenerBeat写同步可见动作。每项subshots数量等于连续说话人轮次数：同一说话人的相邻完整句合并，换人再切，静默反应和动作结果并入首末对白段内部；整镜只用蓝图0–2名visibleCharacterIds，每段只有一个主口型。前60秒不得连续两个单元由同一人物独白。",
      "emotionArc和performanceBeats必须从事件和人物立场推导，落到眉眼、下颌、泪线、呼吸、手指、重心与嗓音变化：赶人要气急压迫，受辱要委屈断气或哭腔，知恩后悔要失声→破音→哭着完成短句；情绪按冲突升级，禁止全员一直平静或无差别吼叫。切镜只由台词、视线、动作、物件、入场或声音驱动，尾帧保持微动作。商品按packshot/detail/use/result/reaction拆镜，整体/细节不出现无关人脸。",
      `${sharedDramaWritingContract(totalSeconds)}\n0秒附近开口，末句在结束前完整说完，并留足反应与动作时间。H3英文提示由系统后编译，本阶段不输出hailuoPrompt。`
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
