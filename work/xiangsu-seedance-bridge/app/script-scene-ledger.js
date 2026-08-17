"use strict";

const PLACEHOLDER_SCENE = /^(?:用户原稿场景|原稿场景|剧情现场|剧情主要空间|主要场景|场景)\s*\d*$/i;

function clean(value = "") {
  return String(value || "").replace(/\uFEFF/g, "").replace(/[\t\u00a0]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSceneName(value = "") {
  let name = clean(value)
    .replace(/^[\[【(（《<]\s*/, "")
    .replace(/\s*[\]】)）》>]$/, "")
    .replace(/^(?:场景|地点|内景|外景)\s*[:：-]?\s*/i, "")
    .replace(/^(?:转场|切至|切到|转至|来到)\s*[:：-]?\s*/i, "")
    .replace(/^@+/, "")
    .replace(/[。；;，,]+$/, "")
    .trim();
  name = name.replace(/集团总裁办(?:公室)?/g, "总裁办公室").replace(/总裁办(?!公室)/g, "总裁办公室");
  return name;
}

function sceneSemanticKey(value = "") {
  return normalizeSceneName(value)
    .replace(/宽大(?:的)?|巨大(?:的)?|高档|豪华|气派|室内|室外/g, "")
    .replace(/办公桌前|桌前|收银台前/g, "")
    .replace(/大门前|门前/g, "门口")
    .replace(/机场免税店/g, "免税店")
    .replace(/集团总部大楼/g, "集团总部")
    .replace(/[\s·•._-]+/g, "")
    .toLowerCase();
}

function splitCompoundSceneName(value = "") {
  const normalized = normalizeSceneName(value);
  if (!normalized) return [];
  // A compound heading declares an ordered location transition. Fountain's
  // INT/EXT slash belongs to its syntax and is removed before this function.
  return normalized.split(/\s*(?:-{1,2}>|→|⇒|➜|\/|／|\||｜|转场至|转至|切至|切到|再到|然后到)\s*/i)
    .map(normalizeSceneName)
    .filter(Boolean);
}

function parseSceneHeading(line = "") {
  const text = String(line || "").trim();
  if (!text || text.length > 180) return null;
  // Acts and shot headers describe narrative structure, camera coverage or
  // presentation. They are never reusable physical scene assets.
  if (/分镜\s*\d+/i.test(text)) return null;
  let match = text.match(/^(?:唯一\s*)?场景\s*(?:固定|设定|锁定)\s*[:：]\s*(.+)$/i);
  if (match) {
    const raw = clean(match[1])
      .split(/[，,；;。]/, 1)[0]
      .replace(/^SC\s*0*\d+\s*/i, "")
      .trim();
    return raw ? { raw, kind: "fixed_scene" } : null;
  }
  match = text.match(/^(?:#{1,6}\s*)?【\s*场景\s*】\s*(.+)$/i);
  if (match) return { raw: clean(match[1]), kind: "bracketed" };
  match = text.match(/^(?:#{1,6}\s*)?场景\s*[:：]\s*(.+)$/i);
  if (match) {
    const raw = clean(match[1]);
    return { raw, kind: raw.startsWith("@") ? "tagged" : "labelled" };
  }
  match = text.match(/^(?:#{1,6}\s*)?第[一二三四五六七八九十百千零〇\d]+场\s*[:：、.-]?\s*(.+)$/i);
  if (match) return { raw: clean(match[1]), kind: "numbered_chinese" };
  // SC01 is a scene identifier. S01 is a shot identifier and must never be
  // promoted into a scene asset, even when it contains time/camera/action fields.
  match = text.match(/^(?:#{1,6}\s*)?SC\d{1,4}\b\s*[:：、.\-]?\s*(.+)$/i);
  if (match) return { raw: clean(match[1]), kind: "structured" };
  match = text.match(/^(?:#{1,6}\s*)?(?:INT\.?|EXT\.?|INT\s*\/\s*EXT\.?|I\s*\/\s*E\.?)\s+(.+)$/i);
  if (match) return { raw: clean(match[1]).replace(/\s+[-—]\s*(?:DAY|NIGHT|日|夜|晨|晚).*$/i, ""), kind: "fountain" };
  match = text.match(/^(?:#{1,6}\s*)?(?:地点|内景|外景)\s*[:：]\s*(.+)$/i);
  if (match) return { raw: clean(match[1]), kind: "location" };
  return null;
}

function transitionTarget(line = "") {
  const text = String(line || "").trim();
  const match = text.match(/^[（(\[]?\s*(?:转场|切至|切到|转至|来到)\s*[:：-]?\s*([^）)\]\n]{2,80})[）)\]]?\s*$/i);
  return match ? normalizeSceneName(match[1]) : "";
}

function findScene(catalogue, value, candidates = catalogue) {
  const name = normalizeSceneName(value);
  const key = sceneSemanticKey(name);
  if (!key) return null;
  const exact = candidates.find(item => item.semanticKey === key || normalizeSceneName(item.name) === name);
  if (exact) return exact;
  const scored = candidates.map(item => {
    const other = item.semanticKey;
    let score = 0;
    if (key.includes(other) || other.includes(key)) score += Math.min(key.length, other.length) * 4;
    for (const token of ["公寓", "走廊", "办公室", "集团总部", "免税店", "门口", "客厅", "餐厅", "卧室", "医院", "学校", "街", "车内"]) {
      if (key.includes(token) && other.includes(token)) score += token.length * 3;
    }
    return { item, score };
  }).sort((left, right) => right.score - left.score);
  return scored[0]?.score >= 6 ? scored[0].item : null;
}

function isPresentationSceneVariant(value = "") {
  return /(?:直播|主观|监控|采访|航拍|跟拍)?(?:视角|机位|镜头|画面)$/i.test(normalizeSceneName(value));
}

function buildSourceSceneLedger(value = "") {
  const source = String(value || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const catalogue = [];
  const occurrences = [];
  const headingKinds = new Set();
  const lines = [];
  let cursor = 0;
  for (const text of source.split("\n")) {
    lines.push({ text, start: cursor, end: cursor + text.length });
    cursor += text.length + 1;
  }
  const addScene = (rawName, sourceStart, declared = true, kind = "") => {
    const name = normalizeSceneName(rawName);
    if (!name || PLACEHOLDER_SCENE.test(name)) return null;
    const semanticKey = sceneSemanticKey(name);
    // A declared heading is authoritative. Similar broad words such as
    // "公寓" must never merge 客厅、走廊 and 门口 into one asset.
    const exact = catalogue.find(item => item.semanticKey === semanticKey);
    const descriptiveLabel = kind === "labelled" && (/^(?:室内|室外)/.test(clean(rawName)) || /[，,。；;]/.test(clean(rawName)));
    const presentationVariant = kind === "tagged" && isPresentationSceneVariant(name);
    let scene = exact || ((descriptiveLabel || presentationVariant || !declared) ? findScene(catalogue, name) : null);
    if (!scene) {
      scene = {
        id: `SRC_SC${String(catalogue.length + 1).padStart(3, "0")}`,
        order: catalogue.length + 1,
        name,
        semanticKey,
        aliases: [],
        sourceStarts: []
      };
      catalogue.push(scene);
    } else if (name !== scene.name && name.length <= 60 && !scene.aliases.includes(name)) {
      scene.aliases.push(name);
    }
    if (declared && !scene.sourceStarts.includes(sourceStart)) scene.sourceStarts.push(sourceStart);
    return scene;
  };
  const pushOccurrence = (scene, sourceStart, sourceEnd, reason, rawName) => {
    if (!scene) return;
    const previous = occurrences.at(-1);
    if (previous?.sceneId === scene.id) return;
    if (previous && previous.sourceEnd == null) previous.sourceEnd = sourceStart;
    occurrences.push({
      id: `SRC_OCC${String(occurrences.length + 1).padStart(3, "0")}`,
      order: occurrences.length + 1,
      sceneId: scene.id,
      sceneName: scene.name,
      rawName: normalizeSceneName(rawName || scene.name),
      sourceStart,
      sourceEnd: sourceEnd ?? null,
      reason
    });
  };

  let pending = [];
  for (const line of lines) {
    const heading = parseSceneHeading(line.text);
    if (heading) {
      headingKinds.add(heading.kind);
      const parts = splitCompoundSceneName(heading.raw);
      const declared = parts.map(part => addScene(part, line.start, true, heading.kind)).filter(Boolean);
      pending = declared.slice(1);
      pushOccurrence(declared[0], line.start, null, "heading", parts[0]);
      continue;
    }
    const explicitTransition = transitionTarget(line.text);
    if (explicitTransition) {
      const candidates = pending.length ? pending : catalogue;
      const scene = findScene(catalogue, explicitTransition, candidates) || addScene(explicitTransition, line.start, false);
      pushOccurrence(scene, line.start, null, "transition", explicitTransition);
      pending = pending.filter(item => item.id !== scene?.id);
      continue;
    }
    if (pending.length && /^[（(\[]/.test(String(line.text || "").trim())) {
      const textKey = sceneSemanticKey(line.text);
      const scene = pending.find(item => textKey.includes(item.semanticKey) || (item.semanticKey.includes("办公室") && /办公室/.test(line.text)));
      if (scene) {
        pushOccurrence(scene, line.start, null, "compound_heading_continuation", scene.name);
        pending = pending.filter(item => item.id !== scene.id);
      }
    }
  }
  if (occurrences.at(-1)) occurrences.at(-1).sourceEnd = source.length;
  const unvisited = catalogue.filter(scene => !occurrences.some(item => item.sceneId === scene.id));
  for (const scene of unvisited) {
    const start = scene.sourceStarts[0] ?? source.length;
    pushOccurrence(scene, start, source.length, "declared_compound_scene", scene.name);
  }
  occurrences.sort((a, b) => a.sourceStart - b.sourceStart || a.order - b.order);
  occurrences.forEach((item, index) => {
    item.order = index + 1;
    item.sourceEnd = occurrences[index + 1]?.sourceStart ?? source.length;
  });
  return {
    version: 1,
    sourceLength: source.length,
    explicit: catalogue.length > 0,
    headingKinds: [...headingKinds],
    catalogue,
    occurrences,
    report: {
      declaredSceneCount: catalogue.length,
      occurrenceCount: occurrences.length,
      transitionCount: occurrences.filter(item => item.reason !== "heading").length,
      aliasesMerged: catalogue.reduce((sum, item) => sum + item.aliases.length, 0),
      unresolvedSceneCount: catalogue.length ? 0 : 1
    }
  };
}

function sceneAtSourceOffset(ledger, offset) {
  const position = Math.max(0, Number(offset) || 0);
  const occurrences = Array.isArray(ledger?.occurrences) ? ledger.occurrences : [];
  return [...occurrences].reverse().find(item => position >= item.sourceStart) || occurrences[0] || null;
}

function bindDialogueLedgerToScenes(dialogueLedger = [], sceneLedger = {}) {
  return (Array.isArray(dialogueLedger) ? dialogueLedger : []).map(item => {
    const occurrence = sceneAtSourceOffset(sceneLedger, item.sourceStart);
    return occurrence ? { ...item, sourceSceneId: occurrence.sceneId, sourceSceneName: occurrence.sceneName } : { ...item };
  });
}

function sceneContextForRange(ledger, start, end) {
  const catalogue = Array.isArray(ledger?.catalogue) ? ledger.catalogue : [];
  if (!catalogue.length) return { version: 1, explicit: false, catalogue: [], occurrences: [] };
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  const active = sceneAtSourceOffset(ledger, from);
  const occurrences = (ledger.occurrences || []).filter(item => item.sourceStart < to && item.sourceEnd > from);
  if (active && !occurrences.some(item => item.id === active.id)) occurrences.unshift(active);
  const ids = new Set(occurrences.map(item => item.sceneId));
  for (const scene of catalogue) {
    if (scene.sourceStarts.some(position => position >= from && position < to)) ids.add(scene.id);
  }
  return {
    version: 1,
    explicit: true,
    catalogue: catalogue.filter(item => ids.has(item.id)).map(item => ({ ...item })),
    occurrences: occurrences.map(item => ({ ...item }))
  };
}

function sourceScenePromptBlock(sceneLedger = {}) {
  const catalogue = Array.isArray(sceneLedger?.catalogue) ? sceneLedger.catalogue : [];
  if (!sceneLedger?.explicit || !catalogue.length) return "原稿未提供明确场景标题：只能依据事件地点建立具体场景名，禁止使用‘剧情主要空间’等占位名。";
  const occurrences = Array.isArray(sceneLedger.occurrences) ? sceneLedger.occurrences : [];
  return [
    "【本地已锁定的原稿场景账本：最高优先级，不得合并、改名或新增占位场景】",
    ...catalogue.map(item => `${item.id}｜${item.name}${item.aliases.length ? `｜别名:${item.aliases.join("、")}` : ""}`),
    `本段场景顺序：${occurrences.map(item => `${item.sceneId}:${item.sceneName}`).join(" → ") || catalogue.map(item => `${item.id}:${item.name}`).join(" → ")}`,
    "每个 shot.scene 必须只填写一个上述具体场景；‘A/B’、‘A→B’、‘剧情主要空间’均非法。转场前后必须分属不同 shot，sourceDialogueBindings 所在原稿场景优先决定 shot 场景。"
  ].join("\n");
}

function enforceSourceSceneLedger(analysis = {}, sceneLedger = {}, dialogueLedger = []) {
  const catalogue = Array.isArray(sceneLedger?.catalogue) ? sceneLedger.catalogue : [];
  if (!sceneLedger?.explicit || !catalogue.length) return { ...analysis, sourceSceneLedger: sceneLedger };
  const dialogueById = new Map((Array.isArray(dialogueLedger) ? dialogueLedger : []).map(item => [String(item.id || ""), item]));
  const inputScenes = Array.isArray(analysis?.scenes) ? analysis.scenes : [];
  const sceneFromToken = token => {
    const raw = clean(token);
    if (!raw || PLACEHOLDER_SCENE.test(raw)) return null;
    return findScene(catalogue, raw);
  };
  const scenes = catalogue.map((sourceScene, index) => {
    const matched = inputScenes.find(item => sceneFromToken(item?.name || item?.id)?.id === sourceScene.id) || {};
    return {
      ...matched,
      id: sourceScene.id,
      name: sourceScene.name,
      sourceSceneId: sourceScene.id,
      sourceAliases: [...sourceScene.aliases],
      sourceOrder: sourceScene.order,
      source: "uploaded_script_scene_ledger"
    };
  });
  const occurrenceOrder = [...new Set((sceneLedger.occurrences || []).map(item => item.sceneId))].filter(id => catalogue.some(item => item.id === id));
  const orderedIds = occurrenceOrder.length ? occurrenceOrder : catalogue.map(item => item.id);
  const shots = (Array.isArray(analysis?.shots) ? analysis.shots : []).map((shot, index, all) => {
    const bindingIds = [
      ...(Array.isArray(shot?.sourceDialogueIds) ? shot.sourceDialogueIds : []),
      ...(Array.isArray(shot?.sourceDialogueBindings) ? shot.sourceDialogueBindings.map(item => typeof item === "string" ? item : item?.sourceDialogueId) : []),
      ...(Array.isArray(shot?.dialogueTurns) ? shot.dialogueTurns.map(item => item?.sourceDialogueId) : [])
    ].map(String).filter(Boolean);
    const dialogueSceneIds = [...new Set(bindingIds.map(id => dialogueById.get(id)?.sourceSceneId).filter(Boolean))];
    let scene = dialogueSceneIds.length === 1 ? catalogue.find(item => item.id === dialogueSceneIds[0]) : null;
    if (!scene) scene = sceneFromToken(shot?.scene || shot?.sceneName || shot?.sceneId);
    if (!scene) {
      const slot = Math.min(orderedIds.length - 1, Math.floor(index * orderedIds.length / Math.max(1, all.length)));
      scene = catalogue.find(item => item.id === orderedIds[Math.max(0, slot)]) || catalogue[0];
    }
    return { ...shot, scene: scene.name, sceneName: scene.name, sceneId: scene.id, sourceSceneId: scene.id };
  });
  return { ...analysis, scenes, shots, sourceSceneLedger: sceneLedger };
}

function assertSourceSceneParity(analysis = {}, sceneLedger = {}) {
  const catalogue = Array.isArray(sceneLedger?.catalogue) ? sceneLedger.catalogue : [];
  if (!sceneLedger?.explicit || !catalogue.length) return true;
  const sceneIds = new Set((analysis.scenes || []).map(item => String(item?.sourceSceneId || item?.id || "")));
  const missing = catalogue.filter(item => !sceneIds.has(item.id));
  const invalidShots = (analysis.shots || []).filter(item => PLACEHOLDER_SCENE.test(clean(item?.scene || item?.sceneName)) || !sceneIds.has(String(item?.sourceSceneId || item?.sceneId || "")));
  if (missing.length || invalidShots.length) {
    throw Object.assign(new Error(`原稿场景合同未满足：缺少 ${missing.map(item => item.name).join("、") || "无"}；错误绑定镜头 ${invalidShots.length} 个`), {
      code: "SOURCE_SCENE_PARITY_FAILED",
      missingScenes: missing.map(item => item.name),
      invalidShotIds: invalidShots.map(item => item.id).filter(Boolean)
    });
  }
  return true;
}

module.exports = {
  PLACEHOLDER_SCENE,
  assertSourceSceneParity,
  bindDialogueLedgerToScenes,
  buildSourceSceneLedger,
  enforceSourceSceneLedger,
  normalizeSceneName,
  parseSceneHeading,
  sceneAtSourceOffset,
  sceneContextForRange,
  sourceScenePromptBlock,
  splitCompoundSceneName
};
