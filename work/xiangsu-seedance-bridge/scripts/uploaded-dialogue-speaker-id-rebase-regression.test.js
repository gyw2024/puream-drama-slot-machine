"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertSourceDialogueParity,
  bindSourceDialogueLedgerToAnalysis,
  conformImportedAnalysisToDurationContract,
  enforceCanonicalUploadedCharacterManifest,
  parseAiStandardizedProductionScript,
  productionDialogueLedgerFromScript,
  splitUploadedScriptSections
} = require("../app/workbench-workflow");

const PRODUCTION_SCRIPT = [
  "### S01｜场景：私人会所玻璃长廊",
  "【人物】顾云舟、林曼秋、哈桑·纳迪尔",
  "【核心物品】邀请券",
  "【动作】林曼秋先问邀请券，哈桑回答；顾云舟在玻璃外看见二人。",
  "【对白】林曼秋（低声）：邀请券带了吗？",
  "哈桑（轻浮）：带了，先给我奖励。",
  "【声音】室内环境声",
  "【承接】顾云舟推门进入。",
  "",
  "### S02｜场景：私人会所玻璃长廊",
  "【人物】顾云舟、林曼秋、哈桑·纳迪尔、礼宾主管",
  "【核心物品】邀请券",
  "【动作】顾云舟质问，礼宾主管从门外确认主席通道。",
  "【对白】顾云舟：六年婚姻，不值一张券？",
  "礼宾主管：顾主席，主席通道已开。",
  "【声音】玻璃门声",
  "【承接】众人转向主席通道。"
].join("\n");

function projectFixture() {
  return {
    productionPlan: { inputMode: "manual" },
    generation: { targetDurationSeconds: 20, shotDuration: 10 },
    product: { name: "" },
    script: {
      raw: "S01 00:00—00:10 私人会所玻璃长廊\nS02 00:10—00:20 私人会所玻璃长廊",
      formatAdaptation: {
        version: 4,
        productionScript: PRODUCTION_SCRIPT,
        assetBible: {
          characters: [
            { name: "顾云舟", role: "董事长" },
            { name: "林曼秋", role: "妻子" },
            { name: "哈桑·纳迪尔", role: "合作商" },
            { name: "礼宾主管", role: "礼宾" }
          ],
          scenes: [{ name: "私人会所玻璃长廊" }]
        }
      }
    }
  };
}

test("canonical character-id rebasing keeps immutable dialogue speakers by authored name", () => {
  const project = projectFixture();
  const ledger = productionDialogueLedgerFromScript(
    PRODUCTION_SCRIPT,
    splitUploadedScriptSections(PRODUCTION_SCRIPT)
  );
  const compiled = parseAiStandardizedProductionScript(PRODUCTION_SCRIPT, project, { dialogueLedger: ledger });
  const conformed = conformImportedAnalysisToDurationContract(compiled, project, { advisoryDurationOnly: true });

  assert.deepEqual(conformed.sourceDialogueLedger.map(item => item.speaker), [
    "林曼秋", "哈桑", "顾云舟", "礼宾主管"
  ]);
  assert.equal(conformed.sourceDialogueLedger[0].speakerId, "C02", "pre-rebase id proves the stale-id hazard");

  const authoritativeLedger = conformed.sourceDialogueLedger;
  const enforced = enforceCanonicalUploadedCharacterManifest(conformed, PRODUCTION_SCRIPT, authoritativeLedger);
  assert.deepEqual(enforced.characters.slice(0, 4).map(item => [item.id, item.name]), [
    ["C01", "林曼秋"],
    ["C02", "哈桑"],
    ["C03", "顾云舟"],
    ["C04", "礼宾主管"]
  ]);

  const rebound = bindSourceDialogueLedgerToAnalysis(enforced, authoritativeLedger);
  assert.equal(assertSourceDialogueParity(rebound, authoritativeLedger), true);
  assert.deepEqual(rebound.sourceDialogueLedger.map(item => [item.id, item.speakerId, item.speaker]), [
    ["D001", "C01", "林曼秋"],
    ["D002", "C02", "哈桑"],
    ["D003", "C03", "顾云舟"],
    ["D004", "C04", "礼宾主管"]
  ]);
  assert.deepEqual(rebound.shots.flatMap(shot => shot.dialogueTurns).map(turn => [turn.sourceDialogueId, turn.speaker]), [
    ["D001", "林曼秋"],
    ["D002", "哈桑"],
    ["D003", "顾云舟"],
    ["D004", "礼宾主管"]
  ]);
});
