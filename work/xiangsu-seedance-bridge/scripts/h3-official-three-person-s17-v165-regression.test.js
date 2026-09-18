"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { defaultPromptTemplates } = require("../app/prompt-library");
const { assertHailuoFinalPromptIntegrity, englishWordCount } = require("../app/hailuo-h3-prompt");
const { assertSystemPromptDialogueParity, finalizeVideoPromptForSubmission } = require("../app/workbench-workflow");

const PROJECT_FILE = path.join(
  process.env.APPDATA,
  "xiangsu-seedance-bridge",
  "workbench",
  "projects",
  "project_mtm33a55_1fa38401",
  "project.json"
);

function occurrences(source, token) {
  return String(source || "").split(token).length - 1;
}

test("H3 compiler contract allows an authored silent third character and follows official Ref2VA grammar", () => {
  // 编译器模板已从英文六段式换代为中文合同 generation-methods-20260915-v1。
  // 断言按"语义等价"迁移，不再匹配已退役的英文字面串；每一项都必须能在
  // 当前模板里找到对应条款，否则就是真实回归。
  const compiler = defaultPromptTemplates().hailuoPromptCompiler;
  assert.match(compiler, /GENERATION METHOD generation-methods-20260915-v1/,
    "编译器必须显式带当前版本标记，避免旧缓存被当成新合同继续付款");
  assert.match(compiler, /按真实供应商、实际图片\/音频\/视频参考输入选择官方提示词协议；不要只凭软件模式名称猜协议/,
    "official six-section order：按真实供应商/协议渲染，不凭软件模式名猜");
  assert.match(compiler, /每个有意义的在场人物保留独立身份，包括沉默听者；机位主体不等于全部可见人物/,
    "A three-person scene is valid：沉默听者保留独立身份，机位主体不等于全部可见人物");
  assert.match(compiler, /只在真正发声处出现一次/,
    "actual vocal events：只在真正发声处出现一次");
  assert.match(compiler, /进出场/,
    "entrance beat：进出场必须保留");
  assert.doesNotMatch(compiler, /max(?:imum)?\s+(?:of\s+)?(?:two|2|three|3)\s+(?:visible\s+)?faces/i);
  assert.doesNotMatch(compiler, /最多\s*\d+\s*(?:张|个|名)/, "不得存在可见人数硬上限");
  assert.doesNotMatch(compiler, /不超过\s*\d+\s*(?:张|个|名)/, "不得存在可见人数硬上限");
});

// §10.3：本用例依赖用户本机真实工程库中的一个具体项目文件，属于环境依赖用例。
// 工程不存在时必须显式跳过并说明原因，绝不能据此宣称"用户本机必然通过"，
// 也不能把缺失的环境伪装成断言通过。用户在自测机上跑时会真实执行全部断言。
test("live S17 is entrance -> villain recognition -> kneel -> apology with correct speaker/listener ownership", { skip: !fs.existsSync(PROJECT_FILE) ? `需要本机真实工程 ${PROJECT_FILE}（环境依赖，不在 CI/沙箱内伪造通过）` : false }, () => {
  const project = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
  const shot = project.shots.find(item => item.id === "S17");
  assert.ok(shot, "missing S17");
  assert.deepEqual(shot.visibleCharacterIds, ["C02", "C04", "C01"]);
  assert.deepEqual(shot.dialogueTurns.map(item => item.sourceDialogueId), ["D033", "D034"]);
  assert.deepEqual(shot.dialogueTurns.map(item => [item.speakerId, item.listenerIds]), [
    ["C02", ["C04"]],
    ["C04", ["C01"]]
  ]);
  const prompt = String(shot.manualVideoPrompt || "");
  assertHailuoFinalPromptIntegrity(prompt, 10000);
  assert.equal(assertSystemPromptDialogueParity(project, shot, prompt, "hailuo-h3"), true);
  assert.equal(finalizeVideoPromptForSubmission(project, "shot", "S17", "shot_video", prompt, "hailuo-h3"), prompt);
  assert.equal(occurrences(prompt, "周……周会长？您怎么冒雨来了？"), 1);
  assert.equal(occurrences(prompt, "九爷！老董事长！周平来迟了，让您受惊了！"), 1);
  assert.match(prompt, /<Subject 1> \(S1\) faces <Subject 2>/);
  assert.match(prompt, /<Subject 2> \(S2\) faces <Subject 3>/);
  const retention = prompt.split("retention_analysis:")[1].split("detailed_description:")[0];
  assert.doesNotMatch(retention, /\(S\d+\)/);
  const detailed = prompt.split("detailed_description:")[1].split("overall_soundscape:")[0];
  const words = englishWordCount(detailed.replace(/<d>[\s\S]*?<\/d>/g, ""));
  assert.ok(words >= 350 && words <= 500, `official detailed-description word count is ${words}`);
  const beats = [
    "[Shot 1]",
    "[Shot 2] At 00:01.250,",
    "[Shot 3] At 00:03.450,",
    "[Shot 4] At 00:05.150,",
    `[Shot 5] At 00:${Number(shot.dialogueTurns[1].end).toFixed(3).padStart(6, "0")},`
  ].map(token => detailed.indexOf(token));
  assert.ok(beats.every(index => index >= 0));
  assert.ok(beats.every((index, i) => i === 0 || index > beats[i - 1]));
  assert.match(detailed, /through the rear-right doorway/);
  assert.match(detailed, /recoils one half-step/);
  assert.match(detailed, /drops onto both knees once/);
  assert.match(detailed, /Already kneeling, Zhou Ping looks up to Yan Jiuye/);
  assert.doesNotMatch(detailed, /DIALOGUE PRIORITY|TONE PRIORITY|EMOTION PRIORITY|ACTION PRIORITY|BLOCKING PRIORITY/);
});
