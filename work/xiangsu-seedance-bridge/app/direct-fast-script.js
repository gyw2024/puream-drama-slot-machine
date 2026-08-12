"use strict";

const crypto = require("node:crypto");

const STAGES = Object.freeze([
  "hook", "hook",
  "pressure", "pressure", "pressure", "pressure", "pressure", "pressure",
  "cost_kindness",
  "pressure", "pressure", "pressure", "pressure", "pressure",
  "cost_kindness",
  "evidence", "evidence", "evidence", "evidence", "evidence", "evidence",
  "main_reversal",
  "payoff", "payoff", "payoff", "payoff",
  "payoff", "payoff", "payoff",
  "ending"
]);

const FALLBACK_LINES = Object.freeze([
  "你把话说清！",
  "别再拿话骗我。",
  "我已经看见了。",
  "这次没有退路。",
  "你现在就回答。",
  "说完我们再走。"
]);

function compact(value, fallback = "", limit = 90) {
  const text = String(value || fallback || "").replace(/\s+/g, " ").trim();
  return text.slice(0, limit);
}

function sourceArray(value) {
  return Array.isArray(value) ? value : [];
}

function spokenLength(value) {
  return String(value || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length;
}

function safeSentence(value, fallback, maxChars = 10) {
  const body = compact(value, fallback, 30).replace(/[，。！？!?；;：:…]+$/g, "");
  const chars = [...body];
  return `${chars.slice(0, Math.max(2, maxChars)).join("")}。`;
}

function fitDialogueLines(source, opening = false, duration = 10) {
  const seconds = Math.max(5, Math.min(15, Number(duration) || 10));
  const targetTurns = 2 + Math.round(seconds * 0.4);
  const minimumCharacters = Math.round(seconds * 3.6);
  const maximumCharacters = Math.round(seconds * 4.4);
  let lines = sourceArray(source).map(item => Array.isArray(item) ? item : [item?.s, item?.x || item?.text])
    .map(([speaker, text]) => ({ speaker: Math.max(1, Number(speaker) || 1), text: safeSentence(text, "", 9) }))
    .filter(item => spokenLength(item.text) >= 2)
    .slice(0, targetTurns);
  while (lines.length < targetTurns) {
    lines.push({ speaker: lines.length % 2 ? 2 : 1, text: safeSentence(FALLBACK_LINES[lines.length], FALLBACK_LINES[lines.length], 8) });
  }
  if (opening) lines[0].text = "别碰我的婚纱！";
  let total = lines.reduce((sum, item) => sum + spokenLength(item.text), 0);
  if (total < minimumCharacters) {
    const fillers = ["现在", "当面", "今天", "马上", "亲口", "认真"];
    for (let index = 0; total < minimumCharacters && index < lines.length * 4; index += 1) {
      const target = lines[index % lines.length];
      const punctuation = /[。！？]$/.test(target.text) ? target.text.slice(-1) : "。";
      target.text = `${target.text.replace(/[。！？]$/g, "")}${fillers[index % fillers.length]}${punctuation}`;
      total = lines.reduce((sum, item) => sum + spokenLength(item.text), 0);
    }
  }
  if (total > maximumCharacters) {
    const budget = maximumCharacters;
    let remaining = budget;
    lines = lines.map((item, index) => {
      const slots = lines.length - index;
      const allowance = Math.max(5, Math.floor(remaining / slots));
      const punctuation = index === 0 && opening ? "！" : "。";
      const text = [...item.text.replace(/[，。！？!?；;：:…]/g, "")].slice(0, allowance).join("");
      remaining -= spokenLength(text);
      return { ...item, text: `${text}${punctuation}` };
    });
  }
  return lines;
}

function directFastResponseSchema() {
  return {
    c: [{ n: "姓名", a: "年龄段", r: "身份与关系", d: "外貌体态" }],
    sc: [{ n: "场景名", d: "空间与剧情任务" }],
    s: [{
      i: 1,
      t: "镜头标题",
      a: "唯一可见动作与结果",
      bf: "开始状态",
      af: "结束后的不可逆状态",
      em: "起始情绪→触发→峰值→余震",
      f: 1,
      v: [1, 2],
      d: [[1, "短台词"], [2, "短台词"]]
    }]
  };
}

function directFastUserPrompt({ topic, product, unitCount, totalSeconds, productStartNumber, segmentStart = 1, segmentEnd = unitCount }) {
  const start = Math.max(1, Math.min(unitCount, Number(segmentStart) || 1));
  const end = Math.max(start, Math.min(unitCount, Number(segmentEnd) || unitCount));
  const segmentCount = end - start + 1;
  return [
    `请写一部${totalSeconds}秒竖屏短剧的紧凑剧情母稿第${start}-${end}镜，共${segmentCount}镜；全剧总计${unitCount}镜。`,
    `题材：${JSON.stringify(topic)}`,
    `商品：${product.name}；卖点：${product.sellingPoints || product.description || "只按用户提供事实"}。`,
    `只输出JSON，根对象严格为c/sc/s。c为3-5名核心人物，序号固定：1=承担牺牲的主角，2=误解主角的亲属或对手，3=关键见证人；sc为3-5个承担不同任务的场景；s必须恰好${segmentCount}项，i从${start}连续到${end}，不得输出区间外镜头。`,
    "每个s只允许t/a/bf/af/em/f/v/d字段：f和v使用c的1起始序号；v最多2人。奇数镜优先双人攻防，偶数镜必须单人近景且d的6句全部由f说，保证至少一半镜头为单人。",
    "每镜d必须恰好6句，每句5-9个可说汉字，台词不能同义复述；双人镜严格轮流攻防。em必须写清起始情绪、触发、峰值和余震。a必须是能拍到的独占动作结果，不能写心理说明。",
    "S01前2秒必须由伤害动作直接开场，第一句必须是6-12字的质问或制止；前60秒不得连续同一人念词，必须有说话人和听者反应交替。",
    `唯一主反转固定在约72%位置。${product.name}及任何俗称在S${String(productStartNumber).padStart(2, "0")}之前绝对禁止出现；S${String(productStartNumber).padStart(2, "0")}-S${String(Math.min(unitCount, productStartNumber + 2)).padStart(2, "0")}才用3镜完成真实需求→自然使用→可见合规体验→人物决定，不写治疗、治愈或医疗承诺。最后一镜回到人物行动结局。`,
    "总JSON尽量紧凑，不要解释，不要Markdown，不要输出画面提示词、声音提示词或模型名称。",
    `结构示例：${JSON.stringify(directFastResponseSchema())}`
  ].join("\n");
}

function characterFallbacks(topic = {}) {
  const relationship = compact(topic.relationship, "家人", 16);
  return [
    { n: "周桂兰", a: "58岁", r: `${relationship}中的母亲，也是长期承担者`, d: "偏瘦、肩背微驼、手指有旧茧" },
    { n: "林晓梅", a: "32岁", r: `${relationship}中的女儿，也是误解者`, d: "利落短发、体态紧绷、动作急" },
    { n: "陈阿姨", a: "61岁", r: "邻居与关键见证人", d: "圆阔脸、灰白短发、步态稳" }
  ];
}

function materializeCharacters(payload, topic) {
  const authored = sourceArray(payload?.c).slice(0, 5);
  const fallbacks = characterFallbacks(topic);
  const merged = [...authored];
  while (merged.length < 3) merged.push(fallbacks[merged.length]);
  return merged.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const fallback = fallbacks[index] || fallbacks.at(-1);
    const name = compact(source.n || source.name, fallback.n, 12);
    const age = compact(source.a || source.age, fallback.a, 12);
    const role = compact(source.r || source.role, fallback.r, 40);
    const description = compact(source.d || source.description, fallback.d, 70);
    const digest = crypto.createHash("sha256").update(`${name}|${age}|${role}`).digest("hex");
    return {
      id: `C${String(index + 1).padStart(2, "0")}`,
      name,
      age,
      role,
      description,
      identitySignature: `${description}；脸部固定识别码${digest.slice(0, 6)}`,
      desire: index === 0 ? "让家人过得体面并守住尊严" : index === 1 ? "弄清真相并弥补旧伤" : "把亲眼见证的事实说清楚",
      fear: index === 0 ? "自己的牺牲拖累家人" : index === 1 ? "发现自己曾伤害最亲的人" : "真话说晚后再也来不及",
      arc: index === 0 ? "从隐忍承担到被行动看见" : index === 1 ? "从误判伤人到承担现实代价并行动修复" : "从旁观到公开作证",
      voiceDescription: `${/母|女|姨|姐|妹/.test(`${name}${role}`) ? "女声" : "中性声"}；中音；生活化颗粒质感；语速平稳；情绪上来时重咬动词`,
      signatureLine: ["今天这件事必须当面说清楚。", "我不再躲了，错在哪里我就补在哪里。", "我亲眼看见的事，今天一句都不会少。", "先把真话摆出来，再谈谁该留下。", "事情到这一步，谁都不能再装糊涂。"][index] || "今天必须把真话说清楚。",
      continuityLocks: [`姓名年龄与脸部识别码${digest.slice(0, 6)}固定`, "发型、体态和声线在同一时间段不得漂移"]
    };
  });
}

function materializeScenes(payload) {
  const authored = sourceArray(payload?.sc).slice(0, 5);
  const fallbacks = [
    { n: "旧家缝纫间", d: "旧木桌、缝纫机、窗边工作区，承担伤害钩子与牺牲行动" },
    { n: "婚礼后厅与旧物房", d: "衣架、纸箱、桌面物证区，承担证据递进和主反转" },
    { n: "社区缝纫工作室", d: "裁剪台、低柜、通道与工作垫，承担行动回收和商品自然使用" }
  ];
  const merged = [...authored];
  while (merged.length < 3) merged.push(fallbacks[merged.length]);
  return merged.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const fallback = fallbacks[index] || fallbacks.at(-1);
    const name = compact(source.n || source.name, fallback.n, 18);
    const description = compact(source.d || source.description, fallback.d, 90);
    return {
      id: `SC${String(index + 1).padStart(2, "0")}`,
      name,
      interiorExterior: "内景",
      time: index === 0 ? "夜间" : index === 1 ? "日间" : "午后",
      description,
      lighting: index === 0 ? "暖黄侧光与窗外冷光对比" : "自然散射光，物证区域更亮",
      atmosphere: index === 0 ? "室内环境底噪、缝纫机与衣料摩擦" : "室内环境底噪、脚步与纸张动作声",
      scenePurpose: description,
      entryAction: "人物带着上一场未解决的动作或物件进入",
      exitAction: "完成本场不可逆行动后离开画面",
      cameraAnchors: ["门口关系位", "工作台侧向位", "人物正反打位"],
      transitionReason: "由上一场动作、物件或声音桥自然切入"
    };
  });
}

function stageFor(index, unitCount) {
  if (unitCount === 30) return STAGES[index];
  const reversal = Math.min(unitCount - 3, Math.max(1, Math.round(unitCount * 0.72 - 0.5)));
  if (index === reversal) return "main_reversal";
  if (index < 2) return "hook";
  if (index < Math.round(unitCount * 0.5)) return index % Math.max(3, Math.round(unitCount / 12)) === 0 ? "cost_kindness" : "pressure";
  if (index < reversal) return "evidence";
  return index === unitCount - 1 ? "ending" : "payoff";
}

function sceneFor(index, unitCount, scenes) {
  const bucket = Math.min(scenes.length - 1, Math.floor(index / Math.ceil(unitCount / scenes.length)));
  return scenes[bucket] || scenes.at(-1);
}

function mapCompactShot(payload, index) {
  const source = sourceArray(payload?.s).find(item => Number(item?.i) === index + 1) || sourceArray(payload?.s)[index] || {};
  return source && typeof source === "object" ? source : {};
}

function deliveryFor(emotion, index) {
  const high = /怒|崩|惊|慌|痛|悔|羞|绝望|决绝/.test(emotion);
  return `${compact(emotion, "克制→受刺激→情绪抬升→压住余震", 45)}；${high ? "中高音量" : "中低音量"}；${index % 3 === 0 ? "先慢后快" : "语速中等"}；重咬动作词；句尾留半拍气口`;
}

function productBridge(productName, character, index) {
  const role = index % 3;
  return {
    situationNeed: role === 0 ? `${character.name}在长时间跪地量裁前需要稳定贴合的日常支撑` : "连续工作后仍需保持自然起身和转身动作",
    whyNow: role === 0 ? "新的工作任务马上开始，人物主动为自己做准备" : "上一镜已经完成真实使用动作，需要观察并作出决定",
    action: role === 0 ? `${character.name}坐下整理${productName}并按膝部轮廓自然戴好` : `${character.name}使用${productName}完成跪地量裁后扶桌起身`,
    observableOutcome: "绑带保持贴合，弯曲、起身与走动过程未见滑移；只呈现日常使用体验",
    relationOrDecisionShift: `${character.id}${character.name}决定继续使用并把照顾自己写进工作安排`
  };
}

function materializeDirectFastScript({ payload, topic, product, filmSchedule }) {
  const unitCount = Math.max(6, Number(filmSchedule.unitCount) || 30);
  const totalSeconds = Math.max(60, Number(filmSchedule.totalSeconds) || 300);
  const characters = materializeCharacters(payload, topic);
  const scenes = materializeScenes(payload);
  const productStartIndex = Math.max(Math.floor(unitCount * 0.65) + 1, unitCount - 4);
  const reversalIndex = Math.min(unitCount - 3, Math.max(1, Math.round(unitCount * 0.72 - 0.5)));
  const plans = [];
  const rawShots = [];

  for (let index = 0; index < unitCount; index += 1) {
    const source = mapCompactShot(payload, index);
    const id = `S${String(index + 1).padStart(2, "0")}`;
    const stage = index === reversalIndex ? "main_reversal" : stageFor(index, unitCount);
    const duration = Number(filmSchedule.suggestedDurations?.[index]) || Math.round(totalSeconds / unitCount);
    const scene = sceneFor(index, unitCount, scenes);
    const authoredFocus = Math.max(1, Math.min(characters.length, Number(source.f) || ((index % characters.length) + 1)));
    const authoredVisible = sourceArray(source.v).map(Number).filter(Number.isFinite).map(value => Math.max(1, Math.min(characters.length, value)));
    const visibleIndexes = index > 0 && index % 2 === 1
      ? [authoredFocus]
      : [...new Set([authoredFocus, ...authoredVisible])].slice(0, 2);
    const productMention = index >= productStartIndex && index < productStartIndex + 3;
    const productRole = productMention ? ["product_packshot", "product_use", "product_result"][index - productStartIndex] : "none";
    const visibleCharacterIds = visibleIndexes.map(value => characters[value - 1]?.id).filter(Boolean);
    const focus = characters[authoredFocus - 1] || characters[0];
    const counterpart = visibleCharacterIds.length > 1 ? characters.find(item => item.id === visibleCharacterIds[1]) : null;
    let dialogueSource = fitDialogueLines(source.d, index === 0, duration);
    if (visibleCharacterIds.length === 1 || productMention) dialogueSource = dialogueSource.map(item => ({ ...item, speaker: authoredFocus }));
    else dialogueSource = dialogueSource.map((item, turnIndex) => ({ ...item, speaker: visibleIndexes[turnIndex % visibleIndexes.length] }));
    const dialogueVisibleIds = productMention ? visibleCharacterIds.slice(0, 1) : visibleCharacterIds;
    const action = index === 0
      ? compact(topic.hook, "对方踢开跪地劳作的人，婚纱裙摆从手中滑落", 88)
      : productRole === "product_packshot"
        ? `${product.name}整体与贴合结构在干净承载面上清晰可见，不出现人物脸部`
      : productMention
        ? productBridge(product.name, focus, index).action
        : compact(source.a || source.action, `${focus.name}完成第${index + 1}个不可逆动作，现场关系随之改变`, 88);
    const before = compact(source.bf, `上一镜结果压到${focus.name}面前`, 65);
    const after = compact(source.af, `${focus.name}用可见动作把关系推进到无法退回的状态`, 65);
    const emotion = compact(source.em, stage === "main_reversal" ? "压抑→看清证据→崩溃→决定承担" : "克制→受刺激→情绪抬升→压住余震", 65);
    const dialogueTurns = (productRole === "product_packshot" ? [] : dialogueSource).map((turn, turnIndex) => {
      const speaker = characters[Math.max(0, Math.min(characters.length - 1, turn.speaker - 1))] || focus;
      const listener = dialogueVisibleIds.map(characterId => characters.find(item => item.id === characterId)).find(item => item && item.id !== speaker.id) || null;
      return {
        speakerId: speaker.id,
        listenerIds: listener ? [listener.id] : [],
        text: turn.text,
        beat: ["attack", "deflect", "counter", "reveal", "counter", "decision"][turnIndex % 6],
        delivery: deliveryFor(emotion, turnIndex),
        body: `${speaker.name}第${turnIndex + 1}句时${turnIndex < 2 ? "手指收紧并稳住重心" : turnIndex < 4 ? "下颌绷住、身体向前半步" : "呼吸停半拍后完成决定动作"}`,
        listenerBeat: listener ? `${listener.name}听见后眼神一顿，肩颈和手部出现可见反应` : "画外听者屏住呼吸，下一镜承接其反应",
        subshotNumber: Math.min(3, Math.floor(turnIndex / 2) + 1),
        onScreen: dialogueVisibleIds.includes(speaker.id)
      };
    });
    const planVisibleIds = productRole === "product_packshot" ? [] : productMention ? visibleCharacterIds.slice(0, 1) : visibleCharacterIds;
    const bridge = productMention ? productBridge(product.name, focus, index) : { situationNeed: "", whyNow: "", action: "", observableOutcome: "", relationOrDecisionShift: "" };
    if (productRole === "product_packshot") bridge.relationOrDecisionShift = "";
    const visualBeat = `${id}独占动作：${action}`;
    const mainlineBeat = stage === "main_reversal"
      ? `主反转：${compact(topic.reversal, action, 70)}`
      : stage === "evidence"
        ? `证据递进：${compact(topic.proofChain, action, 70)}`
        : stage === "cost_kindness"
          ? `有成本善意：${action}`
          : stage === "payoff"
            ? `行动兑现：${action}`
            : action;
    const plan = {
      id,
      title: compact(source.t || source.title, `${stage}·${index + 1}`, 28),
      duration,
      characters: planVisibleIds.map(characterId => characters.find(item => item.id === characterId)?.name).filter(Boolean),
      scenePresenceCharacterIds: planVisibleIds,
      visibleCharacterIds: planVisibleIds,
      focusCharacterId: planVisibleIds[0] || "",
      counterpartCharacterId: planVisibleIds[1] || "",
      shotFunction: productMention ? productRole : (planVisibleIds.length > 1 ? "two_shot" : "speaker_closeup"),
      scene: scene.name,
      sceneObjective: mainlineBeat,
      transitionReason: index === 0 ? "冷开场直接砸入危机" : "承接上一镜末句、视线与手部动作",
      mainlineStage: stage,
      mainlineBeat,
      kindnessCost: stage === "cost_kindness" ? `${focus.name}为保护家人失去时间、尊严或现实机会` : "无",
      reversalSetup: stage === "evidence" ? compact(topic.proofChain, "可见物证进入画面", 70) : "无",
      action,
      stateBefore: before,
      stateAfter: after,
      causalLink: index === 0 ? "伤害动作发生，所以首句制止立刻引爆母女冲突" : `因为S${String(index).padStart(2, "0")}留下未解决的动作和事实，所以${action}导致${after}`,
      visualBeat,
      compositionPlan: `${index % 3 === 0 ? "人物单人近景" : index % 3 === 1 ? "正反打与手部插入" : "侧向中近景轻推"}；保持人物视线朝听者而非镜头`,
      audioPlan: `0-${duration}秒连续室内环境底噪；对白清晰；脚步、衣料摩擦、纸张或器物动作特效声同步；只保留现场声`,
      dialogueGoal: "6句递进攻防，只新增一条信息并由末句触发可见动作",
      dialogueArc: {
        entryCause: before,
        speakerGoalA: `${focus.name}逼对方正面回应刚发生的事实`,
        speakerGoalB: counterpart ? `${counterpart.name}试图守住原判断或现实利益` : "画外听者必须作出回应",
        newInformation: mainlineBeat,
        exitConsequence: after
      },
      emotion,
      emotionArc: { start: emotion.split("→")[0] || "克制", trigger: action, peak: emotion.split("→")[2] || "情绪抬升", aftershock: emotion.split("→").at(-1) || "余震" },
      performanceBeats: { faceAction: "眉眼、下颌和泪线随台词逐句变化", bodyAction: "手部、肩颈和重心在末句完成状态改变", voiceDelivery: deliveryFor(emotion, index), listenerReaction: counterpart ? `${counterpart.name}逐句出现眼神、呼吸和手部反应` : "听者反应由画外呼吸与下一镜承接" },
      startFrame: `${scene.name}中${focus.name}保持${before}的姿态，视线落向听者`,
      endFrame: `${focus.name}完成${after}的动作后仍有呼吸、手指或泪线微动`,
      tragedy: null,
      faceSlap: stage === "main_reversal" ? { attack: "旧判断被公开", proof: compact(topic.proofChain, "物证落桌", 70), reaction: "过错方失语并失去退路", action: "主角完成现实清算" } : null,
      silenceBeat: null,
      motifRecall: compact(topic.themeObject, "核心物件", 45),
      storyCoreRefs: ["valueStatement", "protagonistWound", "themeObject"],
      reversalRole: stage === "main_reversal" ? "唯一主反转并完成证据重释" : stage === "evidence" ? "推进可见证明链" : "为唯一主反转积累关系和行动代价",
      imageReferenceCharacterIds: planVisibleIds,
      videoReferenceCharacterIds: planVisibleIds,
      offscreenSpeakerIds: [],
      wardrobeBindings: planVisibleIds.map(characterId => ({ characterId, wardrobeId: `wardrobe_${characterId}`, continuity: "同一时段服装、发型与配饰不变" })),
      propBindings: [],
      productMention,
      productShotType: productMention ? productRole : "none",
      productCausalBridge: bridge,
      subshotTarget: 3
    };

    const splitA = Math.max(1, Math.round(duration * 0.3));
    const splitB = Math.max(splitA + 1, Math.round(duration * 0.7));
    const subshotRoles = productMention && index === productStartIndex
      ? ["product_packshot", "product_detail", "product_packshot"]
      : productMention && index === productStartIndex + 1
        ? ["product_use", "product_use", "product_use"]
        : productMention
          ? ["product_result", "product_reaction", "product_reaction"]
          : ["speaker_closeup", planVisibleIds.length > 1 ? "listener_reaction" : "action_insert", "action_insert"];
    const boundaries = [[0, splitA], [splitA, splitB], [splitB, duration]];
    const subshots = boundaries.map(([start, end], subIndex) => {
      const role = subshotRoles[subIndex];
      const cleanProduct = /product_(?:packshot|detail)/.test(role);
      const turns = dialogueTurns.filter(turn => turn.subshotNumber === subIndex + 1);
      return {
        start,
        end,
        shotType: role,
        cutReason: subIndex === 0 ? plan.transitionReason : subIndex === 1 ? "上一句落点后切听者或物件反应" : "手部动作匹配切到结果",
        framing: cleanProduct ? "无脸商品干净特写" : subIndex === 0 ? "说话人中近景" : subIndex === 1 ? "听者反应近景" : "手部与表情结果特写",
        camera: subIndex === 1 ? "轻微推进" : "稳定机位",
        action: cleanProduct ? `${product.name}整体与贴合结构在干净承载面上清晰可见` : `${action}；第${subIndex + 1}段完成可见状态变化`,
        dialogueTurns: turns,
        sound: `连续室内环境底噪；${subIndex === 0 ? "衣料摩擦" : subIndex === 1 ? "脚步与急促呼吸" : "纸张或器物轻响"}动作特效声`,
        transition: subIndex === 2 ? "以末句和动作结果桥接下一镜" : "台词与视线接力",
        visibleCharacterIds: cleanProduct ? [] : planVisibleIds,
        speakerFacing: cleanProduct ? "无人脸" : `${focus.name}朝向听者眼睛`,
        listenerFacing: counterpart ? `${counterpart.name}看向说话人` : "听者位于画外轴线方向",
        eyelineDirection: "保持180度轴线，禁止对镜头念词",
        emotionBeat: ["情绪起始", "触发与峰值", "余震和决定"][subIndex],
        faceAction: cleanProduct ? "无人脸" : "眉心、眼睑、下颌与泪线出现递进变化",
        bodyAction: cleanProduct ? "商品保持稳定、结构清晰" : "手指、肩颈与身体重心完成递进动作",
        voiceDelivery: deliveryFor(emotion, subIndex)
      };
    });
    const rawShot = {
      id,
      title: plan.title,
      action,
      stateBefore: before,
      stateAfter: after,
      causalLink: plan.causalLink,
      visualBeat,
      compositionPlan: plan.compositionPlan,
      audioPlan: plan.audioPlan,
      dialogueArc: plan.dialogueArc,
      dialogueTurns,
      criticalOnScreenText: [],
      emotion,
      emotionArc: plan.emotionArc,
      performanceBeats: plan.performanceBeats,
      performance: `${focus.name}先以${plan.emotionArc.start}压住表情，受动作刺激后眉眼与下颌改变，末句时手部和重心完成决定`,
      soundDesign: `连续室内环境底噪、清晰对白与同步动作特效声，只保留现场声`,
      soundCueSheet: { bed: `0-${duration}秒连续室内环境底噪`, sfx: "衣料摩擦、脚步、呼吸与器物动作特效声", silenceDesign: "非静默单元", motifRecall: compact(topic.themeObject, "核心物件声音母题", 45) },
      transitionIn: plan.transitionReason,
      transitionOut: "以末句、视线或手部动作桥接下一镜",
      startFrame: plan.startFrame,
      endFrame: plan.endFrame,
      subshots,
      productMention,
      productCausalBridge: bridge
    };
    plans.push(plan);
    rawShots.push(rawShot);
  }

  const highlights = sourceArray(topic.highlights).map(item => compact(item, "", 70)).filter(Boolean);
  const storyBible = {
    title: compact(topic.title, "看见她的付出", 24),
    logline: compact(topic.logline, "一段被误解的亲情在可见证据和行动中完成清算与回收。", 140),
    storyMechanism: compact(topic.storyMechanism, "sacrifice_repaid", 24),
    storyCore: {
      storyMechanism: compact(topic.storyMechanism, "sacrifice_repaid", 24),
      valueStatement: compact(topic.valueStatement, "真正的亲情要靠看见和行动回报，而不是口头原谅。", 90),
      protagonistWound: compact(topic.protagonistWound, "长期被轻视后习惯隐忍承担。", 80),
      falseBelief: compact(topic.falseBelief, "只要自己牺牲就能换来家人体面。", 80),
      wantVsNeed: "人物想维持表面体面，真正需要的是看见牺牲、承担后果并改变生活方式",
      antagonistLogic: "误解者用体面和现实利益为伤害辩护，直到证据让其失去退路",
      moralDilemma: "继续隐忍保住表面和睦，还是公开真相让关系承担现实代价",
      irreversibleChoice: "主角把证据和决定公开，拒绝再用沉默替伤害者兜底",
      themeObject: compact(topic.themeObject, "承载牺牲与证据的旧物", 80),
      audienceFeeling: compact(topic.audienceAppeal, "先心疼，再愤怒，最后从行动回收中获得释放。", 90)
    },
    reversalMatrix: {
      audienceBelieves: compact(topic.falseBelief, "承担者的沉默被误读为卑微和无能。", 80),
      antagonistMisdirection: "伤害者把现实牺牲包装成理所当然，让旁人只看见表面不体面",
      evidence1: compact(topic.proofChain, "可见物证与日期证明牺牲真实发生。", 100),
      evidence2: "",
      redHerring: "",
      reinterpretation: [compact(topic.reversal, "旧动作和旧物在主反转时被重新理解。", 100)],
      costAfterReversal: "误解者当众失去体面和辩解退路，并必须用持续行动承担修复成本"
    },
    story: {
      synopsis: compact(`${topic.logline || ""}；${highlights.join("；")}；${topic.emotionalPayoff || ""}`, "亲情误判经由证据和行动完成反转与回收。", 560),
      hook: compact(topic.hook, plans[0]?.action, 100),
      conflict: compact(topic.logline, "亲情牺牲被误解，伤害者拒绝面对现实代价。", 120),
      escalation: plans.filter(item => item.mainlineStage === "pressure").slice(0, 7).map(item => item.action),
      evidence: plans.filter(item => item.mainlineStage === "evidence").slice(0, 4).map(item => item.mainlineBeat),
      costlyKindness: plans.filter(item => item.mainlineStage === "cost_kindness").map(item => item.action),
      mainReversal: plans[reversalIndex]?.mainlineBeat,
      payoff: plans.filter(item => item.mainlineStage === "payoff").slice(-4).map(item => item.action),
      ending: plans.at(-1)?.action
    },
    characters,
    scenes,
    props: [
      { name: compact(topic.themeObject, "核心旧物", 24), appearance: "旧痕、折痕和使用痕迹清楚可辨", holder: `${characters[0].name}转交给${characters[1].name}`, units: [plans[0].id, plans[reversalIndex].id], purpose: "牺牲证据和主题回收", continuity: "外观痕迹与持有人变化必须连续" },
      { name: product.name, appearance: "外观完全以用户上传商品图为准", holder: `${characters[1].name}双手自然操作`, units: plans.filter(item => item.productMention).map(item => item.id), purpose: "反转后的日常行动回收", continuity: "不得虚构品牌、规格、价格或医疗功效" }
    ],
    actPlan: Array.from({ length: 6 }, (_, index) => ({
      act: index + 1,
      timeRange: `${Math.round(index * totalSeconds / 6)}-${Math.round((index + 1) * totalSeconds / 6)}秒`,
      entryState: plans[Math.floor(index * unitCount / 6)]?.stateBefore || "承接上一幕状态",
      irreversibleBeat: plans[Math.min(unitCount - 1, Math.floor((index + 1) * unitCount / 6) - 1)]?.mainlineBeat || "推进主线",
      visualStrategy: ["危机近景", "动作加压", "关系撕裂", "证据插入", "主反转与行动回收", "商品自然使用与结局"][index],
      exitState: plans[Math.min(unitCount - 1, Math.floor((index + 1) * unitCount / 6) - 1)]?.stateAfter || "形成下一幕不可逆入口"
    }))
  };
  return { storyBible, plans, rawShots, productStartNumber: productStartIndex + 1, reversalNumber: reversalIndex + 1 };
}

module.exports = {
  directFastResponseSchema,
  directFastUserPrompt,
  fitDialogueLines,
  materializeDirectFastScript
};
