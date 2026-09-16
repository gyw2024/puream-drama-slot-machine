"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectUploadedScriptFormat, parseSourceDialogueLedger } = require("../app/dialogue-parser");
const { LEGACY_DEFAULT_PROMPT_HASHES, WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow, parseTimedStoryboardScript } = require("../app/workbench-workflow");
const {
  assertSourceSceneParity,
  bindDialogueLedgerToScenes,
  buildSourceSceneLedger,
  enforceSourceSceneLedger,
  sceneContextForRange,
  splitCompoundSceneName
} = require("../app/script-scene-ledger");

const CUSTOMER_PATTERN = `【场景】高档公寓客厅
秦深（平静）：今天怎么有空过来了？

【场景】大平层公寓走廊 -> 集团总裁办
秦深（边走边打电话）：小李，通知中介来我办公室。
（转场：宽大的总裁办公桌前）
小李（递上房产证）：秦总，房产证取出来了。

【场景】机场免税店 / 豪华公寓门口
（转场：免税店收银台前）
林娜（拍卡）：刷卡！
（转场：公寓大门前）
林娜（踹门）：开门！

【场景】集团总部 / 总裁办公室
林娜（冲进大厅）：秦深呢！
（林娜猛地推开总裁办公室的大门）
秦深（冷静）：站那，别出声。`;

test("bracketed Chinese scripts are classified as screenplay before dialogue", () => {
  assert.equal(detectUploadedScriptFormat(CUSTOMER_PATTERN), "chinese_screenplay");
});

test("parenthesized transition and action labels never become dialogue speakers", () => {
  const ledger = parseSourceDialogueLedger(CUSTOMER_PATTERN);
  assert.equal(ledger.length, 7);
  assert.deepEqual([...new Set(ledger.map(line => line.speaker))], ["秦深", "小李", "林娜"]);
  assert.equal(ledger.at(-1).text, "站那，别出声。");
  const labels = parseSourceDialogueLedger("(转场:走廊)\n（动作：推门）\n（镜头说明：缓慢推近）\n秦深（低声）：别走。\n小李（画外）：我在门口。");
  assert.deepEqual(labels.map(line => [line.speaker, line.text]), [["秦深", "别走。"], ["小李", "我在门口。"]]);
});

test("rehearsal bracket headings preserve only real physical locations", () => {
  const source = "【楼道，傍晚】\n甲：灯怎么在这？\n【图书室里】\n乙：孩子在写作业。\n【收尾】\n甲：灯亮了。";
  const ledger = buildSourceSceneLedger(source);
  assert.deepEqual(ledger.catalogue.map(item => item.name), ["楼道", "图书室里"]);
  const dialogue = bindDialogueLedgerToScenes(parseSourceDialogueLedger(source), ledger);
  assert.equal(dialogue[0].sourceSceneName, "楼道");
  assert.equal(dialogue[1].sourceSceneName, "图书室里");
});

test("compound headings and inline transitions become six concrete reusable scenes", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  assert.deepEqual(ledger.catalogue.map(item => item.name), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部"
  ]);
  assert.deepEqual(ledger.occurrences.map(item => item.sceneName), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部",
    "总裁办公室"
  ]);
  assert.equal(ledger.report.declaredSceneCount, 6);
  assert.equal(ledger.report.unresolvedSceneCount, 0);
});

test("dialogue remains bound to the scene active at its source offset", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const dialogue = bindDialogueLedgerToScenes(parseSourceDialogueLedger(CUSTOMER_PATTERN), ledger);
  assert.equal(dialogue.find(item => item.text.includes("通知中介"))?.sourceSceneName, "大平层公寓走廊");
  assert.equal(dialogue.find(item => item.text.includes("房产证取出来"))?.sourceSceneName, "总裁办公室");
  assert.equal(dialogue.find(item => item.text === "刷卡！")?.sourceSceneName, "机场免税店");
  assert.equal(dialogue.find(item => item.text === "开门！")?.sourceSceneName, "豪华公寓门口");
});

test("model placeholders and compound scene inventions are overridden by source truth", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const dialogue = bindDialogueLedgerToScenes(parseSourceDialogueLedger(CUSTOMER_PATTERN), ledger);
  const corrupted = {
    scenes: [
      { id: "SC01", name: "剧情主要空间" },
      { id: "SC02", name: "机场免税店 / 豪华公寓门口" }
    ],
    shots: dialogue.map((item, index) => ({
      id: `U${index + 1}`,
      scene: index % 2 ? "剧情主要空间" : "机场免税店 / 豪华公寓门口",
      sourceDialogueIds: [item.id],
      sourceDialogueBindings: [{ sourceDialogueId: item.id }]
    }))
  };
  const fixed = enforceSourceSceneLedger(corrupted, ledger, dialogue);
  assert.deepEqual(fixed.scenes.map(item => item.name), ledger.catalogue.map(item => item.name));
  assert.ok(fixed.shots.every(item => !/[\/→]|剧情主要空间/.test(item.scene)));
  assert.equal(fixed.shots.find(item => item.sourceDialogueIds.includes("D002"))?.scene, "大平层公寓走廊");
  assert.doesNotThrow(() => assertSourceSceneParity(fixed, ledger));
});

test("chunk context carries the active scene across a split without inventing placeholders", () => {
  const ledger = buildSourceSceneLedger(CUSTOMER_PATTERN);
  const office = ledger.occurrences.find(item => item.sceneName === "总裁办公室");
  const context = sceneContextForRange(ledger, office.sourceStart + 4, office.sourceEnd - 1);
  assert.equal(context.explicit, true);
  assert.ok(context.catalogue.some(item => item.name === "总裁办公室"));
});

test("supported heading matrix remains deterministic", () => {
  const cases = [
    ["第1场 医院走廊\n甲：来了。", "chinese_screenplay", "医院走廊"],
    ["场景：学校操场\n甲：来了。", "chinese_screenplay", "学校操场"],
    ["INT. KITCHEN - NIGHT\nALICE\nHello.", "fountain", "KITCHEN"],
    ["SC01 客厅\n甲：来了。", "structured_production", "客厅"],
    ["地点：老街门口\n甲：来了。", "chinese_screenplay", "老街门口"]
  ];
  for (const [source, format, scene] of cases) {
    assert.equal(detectUploadedScriptFormat(source), format);
    assert.equal(buildSourceSceneLedger(source).catalogue[0]?.name, scene);
  }
  assert.deepEqual(splitCompoundSceneName("A → B / C"), ["A", "B", "C"]);
});

test("compact S01 shot headers never become scenes and a fixed scene stays authoritative", () => {
  const source = [
    "全片20秒，9:16竖屏现实短剧。",
    "唯一场景固定：SC01旧宅客厅，雨夜，木桌上只有一只发黄信封。",
    "S01【0-10秒｜旧宅客厅｜林娜近景切秦添反应】林娜按住信封质问。",
    "S02【10-20秒｜同一客厅｜秦添反打近景】秦添把信封推回。"
  ].join("\n");
  const ledger = buildSourceSceneLedger(source);
  assert.deepEqual(ledger.catalogue.map(item => item.name), ["旧宅客厅"]);
  assert.equal(ledger.occurrences.length, 1);
  assert.equal(ledger.headingKinds.includes("fixed_scene"), true);
});

test("timed storyboard metadata collapses camera variants and preserves explicit assets exactly once", () => {
  const source = `第1幕：【豪门冲突】分镜 1（2个镜头·中等节奏）※ 夜 @陈家豪华别墅客厅 内｜场景固定
场景：@陈家豪华别墅客厅
人物：@秦雪 @婆婆
物品：@粉色塑料盆 @离婚协议书 @蓝色包装盒（清洁棒产品）
场景：室内陈家豪华别墅客厅餐桌旁，夜间雨光。
【0-15秒】镜头：
0-7秒，【中景，秦雪端起粉色塑料盆，无台词】；
7-15秒，【近景，婆婆摔下离婚协议书，@婆婆：“现在签字。”】；
【对话汇总】
@婆婆（音色：@婆婆，7-15秒，冷硬）：“现在签字。”
【音效】文件摔桌声
分镜 2（2个镜头·中等节奏）※ 夜 @陈家客厅直播视角 内｜场景固定
场景：@陈家客厅直播视角
人物：@秦雪
物品：@离婚协议书 @蓝色包装盒
场景：室内陈家豪华别墅客厅转为主观直播视角，夜间。
【0-15秒】镜头：
0-7秒，【近景，秦雪举起协议书，@秦雪：“大家看清楚。”】；
7-15秒，【特写，协议书保持在镜头前，无台词】；
【对话汇总】
@秦雪（音色：@秦雪，0-7秒，坚定）：“大家看清楚。”
【音效】室内底噪
分镜 3（2个镜头·中等节奏）※ 夜 @陈家厨房水槽 内｜场景固定
场景：@陈家厨房水槽
人物：@秦雪
物品：@清洁棒
场景：室内陈家厨房水槽前，夜间明亮。
【0-15秒】镜头：
0-7秒，【中景，秦雪走到水槽前，@秦雪：“我来处理。”】；
7-15秒，【特写，秦雪拿起清洁棒，无台词】；
【对话汇总】
@秦雪（音色：@秦雪，0-7秒，平静）：“我来处理。”
【音效】流水声`;
  const ledger = buildSourceSceneLedger(source);
  assert.deepEqual(ledger.catalogue.map(item => item.name), ["陈家豪华别墅客厅", "陈家厨房水槽"]);
  assert.deepEqual(ledger.occurrences.map(item => item.sceneName), ["陈家豪华别墅客厅", "陈家厨房水槽"]);

  const parsed = parseTimedStoryboardScript(source);
  assert.deepEqual(parsed.scenes.map(item => item.name), ["陈家豪华别墅客厅", "陈家厨房水槽"]);
  assert.deepEqual(parsed.characters.map(item => item.name), ["秦雪", "婆婆"]);
  assert.deepEqual(parsed.props.map(item => item.name), ["粉色塑料盆", "离婚协议书", "蓝色包装盒（清洁棒产品）", "清洁棒"]);
  assert.deepEqual(parsed.props.find(item => item.name === "蓝色包装盒（清洁棒产品）").aliases, ["蓝色包装盒"]);
  assert.deepEqual(parsed.shots[1].props, ["离婚协议书", "蓝色包装盒（清洁棒产品）"]);
  assert.ok(parsed.props.every(item => item.coreStory === true));
  assert.deepEqual(parsed.shots.map(item => item.scene), ["陈家豪华别墅客厅", "陈家豪华别墅客厅", "陈家厨房水槽"]);
});

test("uploaded-script analysis contains the mandatory asset standardization prompt", () => {
  const workflowSource = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const promptSource = fs.readFileSync(path.join(__dirname, "..", "app", "prompt-library.js"), "utf8");
  for (const source of [workflowSource, promptSource]) {
    assert.match(source, /资产提取前置标准化/);
    assert.match(source, /唯一物理空间/);
    assert.match(source, /不得新增原稿没有的资产|禁止多建、漏建/);
  }
  assert.ok(LEGACY_DEFAULT_PROMPT_HASHES.scriptAnalysis.includes("dd0682496427e53e31b05caab21aa420c78f673c0966b9d19ccd895ba3e5d789"));
});

test("explicit source scenes fail closed when a later stage drops them", () => {
  const ledger = buildSourceSceneLedger("【场景】客厅\n甲：一。\n【场景】门口\n乙：二。");
  assert.throws(
    () => assertSourceSceneParity({ scenes: [{ id: ledger.catalogue[0].id, name: "客厅" }], shots: [] }, ledger),
    error => error?.code === "SOURCE_SCENE_PARITY_FAILED" && error.missingScenes.includes("门口")
  );
});

test("sparse uploaded scenes retain the source and continue content repair until an external authentication blocker", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-scene-ledger-flow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const settings = store.getSettings();
  settings.generation.qualityGatesEnabled = false;
  store.saveSettings(settings);
  const project = store.createProject("复合场景剧本全流程", { targetDurationSeconds: 90, inputMode: "manual" });
  store.patchProject(project.id, {
    productionPlan: { inputMode: "manual", executionMode: "full" },
    generation: { engine: "seedance", videoProviderKind: "local-xiangsu", mode: "smart", targetDurationSeconds: 90, shotDuration: 10 },
    script: { raw: CUSTOMER_PATTERN }
  });
  let calls = 0;
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: root,
    textGenerator: async (_config, messages) => {
      const user = String(messages.find(message => message.role === "user")?.content || "");
      if(user.startsWith('{"completeSource":')){calls++;if(calls===4)throw Object.assign(new Error('Account needs sign-in'),{code:'LOCAL_AGENT_AUTH_REQUIRED'});return {sourceTimingIssues:[{exactSourceExcerpt:'林娜（拍卡）：刷卡！',message:'Separate physical scene with only two spoken characters cannot fill a 10-second unit without a silence longer than three seconds.'}]};}
      if (user.includes("UPLOADED_TEXT_TO_STANDARDIZE:\n") || user.startsWith('{"lines":')) {
        const sourceScenes = buildSourceSceneLedger(CUSTOMER_PATTERN);
        const sourceLines = bindDialogueLedgerToScenes(parseSourceDialogueLedger(CUSTOMER_PATTERN), sourceScenes);
        const actions = ["秦深看向客厅来客，抬手示意她坐下。", "秦深沿走廊走向办公室，边走边拿电话通知小李。", "小李来到办公桌前，把房产证递给秦深。", "林娜走到免税店收银台，拍下银行卡。", "林娜来到公寓门口，踹门并怒喊。", "林娜冲进集团总部大厅，停在前台质问。", "林娜推开办公室门，秦深抬掌示意她停步。"];
        return {
          productionScript: sourceLines.map((line, index) => [
            `### S${String(index + 1).padStart(2, "0")}｜场景：${line.sourceSceneName}`,
            `【人物】${line.speaker}`,
            "【核心物品】房产证、手机、银行卡",
            `【动作】${actions[index]}`,
            `【对白】${line.speaker}（语气随当前行动变化）：${line.text}`,
            "【声音】连续室内环境声与动作同步的脚步或物件接触声。",
            "【承接】人物沿原稿给出的行进路线进入下一事件。"
          ].join("\n")).join("\n"),
          sourceAudit: {
            sceneOccurrenceCount: sourceScenes.occurrences.length,
            dialogueCount: sourceLines.length,
            sceneOccurrences: sourceScenes.occurrences.map((scene, index) => ({ order: index + 1, physicalSceneName: scene.sceneName })),
            preservedAllDialogue: true,
            preservedAllScenes: true,
            preservedAllActions: true,
            preservedEventOrder: true,
            noInventedDialogue: true
          }
        };
      }
      calls += 1;
      throw Object.assign(new Error("simulated invalid upstream result"), { code: "TEXT_RESULT_INVALID" });
    }
  });
  await assert.rejects(workflow.analyzeScript(project.id),{code:'LOCAL_AGENT_AUTH_REQUIRED'});
  const analyzed=store.getProject(project.id);assert.equal(calls,4);assert.equal(analyzed.script.raw,CUSTOMER_PATTERN);
  const ledger = buildSourceSceneLedger(analyzed.script.raw);
  assert.deepEqual(ledger.catalogue.map(item => item.name), [
    "高档公寓客厅",
    "大平层公寓走廊",
    "总裁办公室",
    "机场免税店",
    "豪华公寓门口",
    "集团总部"
  ]);
  assert.equal(ledger.catalogue.length, 6);
});
