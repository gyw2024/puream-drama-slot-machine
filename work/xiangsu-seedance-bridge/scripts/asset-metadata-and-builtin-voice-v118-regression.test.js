"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assetBearingCharacters,
  characterAgeBand,
  coreVisualProps,
  deactivateIneligibleProjectAssetBindings,
  decorateProjectAssetMetadata,
  deterministicAppearance,
  explicitCharacterGender,
  isDialogueLikeAppearance,
  propConsumerPlan,
  propPendingDecisions
} = require("../app/asset-eligibility");
const { auditVoiceFile } = require("../app/voice-profile-audit");
const { WorkbenchStore } = require("../app/workbench-store");

const voicePackDir = path.join(__dirname, "..", "app", "assets", "builtin-voices");
const voiceManifest = JSON.parse(fs.readFileSync(path.join(voicePackDir, "manifest.json"), "utf8"));

function projectFixture() {
  return {
    id: "project_asset_metadata_fixture",
    script: {
      sourceDialogueLedger: [
        { speakerId: "C04", text: "顾主席，主席通道已经打开。" },
        { speakerId: "C01", text: "我回来了。" }
      ]
    },
    product: { name: "九宝茶", imagePath: "C:\\fixture\\product.png" },
    characters: [
      { id: "C01", name: "顾云舟", role: "男主，五十多岁", castingTier: "lead", description: "五十多岁男性，灰黑背头，方脸，身形挺拔，穿深色西装。" },
      { id: "C02", name: "苏晚晴", role: "女主初恋，五十多岁", castingTier: "lead", description: "五十多岁女性，银黑短卷发，鹅蛋脸，身形匀称，穿墨绿色礼服。" },
      { id: "C03", name: "银发女士甲", role: "舞会嘉宾", description: "老年女性，银灰短发，圆脸，穿酒红色礼服。" },
      { id: "C04", name: "礼宾主管", role: "主管", description: "“顾主席，主席通道已经打开。”", voiceLibraryId: "voice_offscreen_old" },
      { id: "C05", name: "礼宾人员", role: "工作人员", description: "礼宾人员站在通道两侧。" },
      { id: "C06", name: "路人甲", role: "背景人物", description: "中年男性，短发，普通外套。" },
      { id: "C07", name: "银发女士乙", role: "舞会临时来宾", description: "老年女性，银灰短发，普通礼服。", voiceLibraryId: "voice_extra_old" }
    ],
    shots: [
      { id: "S01", visibleCharacterIds: ["C01"], focusCharacterId: "C01", dialogueTurns: [{ speakerId: "C01", text: "我回来了。", onScreen: true }] },
      { id: "S02", visibleCharacterIds: ["C01", "C02"], focusCharacterId: "C02", dialogueTurns: [] },
      { id: "S03", visibleCharacterIds: ["C01", "C02", "C03", "C07"], focusCharacterId: "C03", dialogueTurns: [{ speakerId: "C07", text: "排队，我先看见的。", onScreen: true }] },
      { id: "S04", visibleCharacterIds: ["C02", "C06"], focusCharacterId: "C02", dialogueTurns: [{ speakerId: "C04", text: "顾主席，主席通道已经打开。", onScreen: false, listenerIds: ["C06"] }], offscreenSpeakerIds: ["C04"] },
      { id: "S05", visibleCharacterIds: ["C01", "C02"], dialogueTurns: [] },
      { id: "S06", visibleCharacterIds: ["C01", "C02"], dialogueTurns: [] }
    ],
    candidates: [
      { id: "A01", entityType: "character", entityId: "C01", stage: "character_sheet", selected: true, reusableAssetId: "asset_lead" },
      { id: "A02", entityType: "character", entityId: "C04", stage: "character_voice", selected: true, voiceLibraryId: "voice_offscreen_old" },
      { id: "A03", entityType: "character", entityId: "C07", stage: "character_sheet", selected: true, reusableAssetId: "asset_extra_old" },
      { id: "A04", entityType: "library", entityId: "P05", stage: "prop_asset", selected: true, reusableAssetId: "asset_teabag_old" }
    ],
    assetLibraries: {
      wardrobes: [],
      props: [
        { id: "P01", name: "婚戒", coreStory: true, units: ["S01"], description: "顾云舟摘下婚戒，决定离婚。" },
        { id: "P02", name: "审计文件", units: ["S02", "S05"], description: "关键审计证据。" },
        { id: "P03", name: "深灰色审计文件夹", units: ["S05"], description: "装审计文件。" },
        { id: "P04", name: "九宝茶", units: ["S04", "S05"], purpose: "产品展示" },
        { id: "P05", name: "独立茶包", units: ["S04"] },
        { id: "P06", name: "透明杯", units: ["S04"] },
        { id: "P07", name: "邀请券", units: ["S03"] },
        { id: "P08", name: "离婚协议", units: ["S02", "S06"] }
      ]
    }
  };
}

test("dialogue stays in the ledger while only direct-shot meaningful people get identity assets", () => {
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(projectFixture()));
  assert.equal(isDialogueLikeAppearance("“顾主席，主席通道已经打开。”", project.script.sourceDialogueLedger), true);
  // GPT §2.6：原断言把「画外台词」「背景标签」「镜内发言」三类混成一个集合，
  // 已确认过期。自动视觉需求集合只取 required；其余由分区显式暴露。
  assert.deepEqual(assetBearingCharacters(project).map(item => item.id), ["C01", "C02", "C03", "C06", "C07"]);

  const offscreen = project.characters.find(item => item.id === "C04");
  // GPT §10.2：不得自动推断叙事层级标签，只保留显式值。
  assert.equal(offscreen.castingTier, undefined);
  assert.equal(offscreen.assetRequired, null, "an offscreen speaker is unknown, never auto-false");
  // 声音范围未证明 → 声音身份是 unknown，绝不能写回 false（GPT §2.4/§4.3）。
  assert.notEqual(offscreen.voiceAssetRequired, false);
  // 台词绝不能泄漏进外貌字段；未填时保持未填，不伪造空串。
  assert.doesNotMatch(String(offscreen.appearanceDescription || ""), /主席通道已经打开/);
  // 消费者必须读派生视图，不再依赖已移除的 assetDecision 快照（GPT §10.2）。
  const offscreenView = project.characterEligibility.find(item => item.characterId === "C04");
  assert.equal(offscreenView.visualRequirement, "unknown");
  assert.match(offscreenView.reason, /missing_visual_evidence|画外/);

  const extra = project.characters.find(item => item.id === "C06");
  assert.equal(extra.castingTier, undefined, "no auto-inferred tier is written back");
  // C06 是镜内被指定的可见听者 —— 听者责任优先于「背景人物」叙事标签（GPT §2.2）。
  assert.equal(extra.assetRequired, true, "a named visible listener keeps a real visual requirement");
  // C07 有镜内具名发言证据，同样必需（GPT §2.5/Q7）。
  assert.equal(project.characters.find(item => item.id === "C07").assetRequired, true, "in-frame named speaker keeps a real visual requirement");
  // C05 是真正未被任何镜头使用的角色，但必须有完整范围证明才算 not_required。
  // 本夹具没有 productionRevision / 覆盖证明 → 必须是待核实，不得当成已解决（GPT §6.2/Q4）。
  const unused = project.characters.find(item => item.id === "C05");
  assert.equal(unused.assetRequired, null, "unproven scope keeps the unused character pending");
  // GPT §2.4：声音范围未证明时，绝不能因为"画外"就剥离用户已绑定的音色。
  // 只有 voiceIdentityRequirement 确认为 not_required 才允许解绑。
  const c04View = project.characterEligibility.find(item => item.characterId === "C04");
  assert.notEqual(c04View.voiceIdentityRequirement, "not_required");
  assert.equal(project.characters.find(item => item.id === "C04").voiceLibraryId, "voice_offscreen_old");
  // 同理，范围未证明时 C07 的音色绑定也保留，不能因"临时来宾"标签就剥离。
  const c07View = project.characterEligibility.find(item => item.characterId === "C07");
  assert.notEqual(c07View.voiceIdentityRequirement, "not_required");
  assert.equal(project.characters.find(item => item.id === "C07").voiceLibraryId, "voice_extra_old");
  assert.equal(project.candidates.find(item => item.id === "A01").selected, true, "eligible lead asset stays selected");
  // GPT §2.4：发声事件是事实，不依赖范围证明。
  // C04 有画外台词、C07 有镜内发言，两者声音身份都必须 required ——
  // 画外/临时来宾的叙事标签不得把声音身份一起降级。
  assert.equal(c04View.voiceIdentityRequirement, "required");
  assert.equal(c07View.voiceIdentityRequirement, "required");
  // 但范围未证实时，两者都不能声称 not_required（否则会误删音色绑定）。
  const c07Candidate = project.candidates.find(item => item.id === "A03");
  assert.equal(c07Candidate.selected, true, "in-frame speaker keeps its sheet candidate");
  // A02 是 C04 的音色候选（character_voice），不是人物图。
  // C04 的声音身份 required → 音色候选必须保留，不能因为"人物图不需要"连带废弃声音资产。
  const c04VoiceCandidate = project.candidates.find(item => item.id === "A02");
  assert.notEqual(c04VoiceCandidate.assetPolicyExcluded, true, "voice identity keeps its voice candidate");
  assert.equal(c04VoiceCandidate.voiceLibraryId, "voice_offscreen_old");
  // 人物图类候选（A03 是 C07 的人物图）应保留；仅 not_required 才排除。
  // 人物外貌描述是 prompt 组装阶段的派生产物；此处只保证
  // (1) 必需角色都能得到可用的确定性外貌描述，(2) 台词绝不泄漏进外貌。
  for (const character of assetBearingCharacters(project)) {
    const appearance = deterministicAppearance(character);
    assert.ok(appearance.length >= 20, `${character.id} gets a usable appearance`);
    assert.doesNotMatch(appearance, /主席通道已经打开/);
    assert.doesNotMatch(String(character.appearanceDescription || ""), /主席通道已经打开/);
  }
  // 角色目录必须始终暴露全量权威实体，而不是只剩必需集合（GPT §4.2）。
  assert.deepEqual(project.characterEligibilityPartition.registryIds,
    ["C01", "C02", "C03", "C04", "C05", "C06", "C07"]);
  assert.deepEqual(project.characterEligibilityPartition.requiredVisualIds,
    ["C01", "C02", "C03", "C06", "C07"]);
});

test("closed-scope unused characters are the only ones that may be marked not_required", () => {
  // 闭合范围：绑定版本 + 完整覆盖证明，才允许把「未使用」判为 not_required。
  const closed = projectFixture();
  closed.productionRevision = "R01";
  closed.sourceLockedAt = "2026-09-18T00:00:00.000Z";
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(closed));
  const partition = project.characterEligibilityPartition;
  assert.equal(project.characterEligibility.find(item => item.characterId === "C05").evidence.scopeVerified, true);
  // 只有真正无任务用途、且范围证明完整的角色才进 noAutomaticVisualIds。
  assert.ok(partition.noAutomaticVisualIds.includes("C05"), "unused character is skipped under a closed scope");
  assert.ok(!partition.noAutomaticVisualIds.includes("C06"), "a listener is not skipped");
  assert.ok(!partition.noAutomaticVisualIds.includes("C07"), "an in-frame speaker is not skipped");
  // 未证明范围完整时，未使用角色只能是待核实，不得被当成已解决（GPT §6.2/Q4）。
  const openScope = projectFixture();
  const open = decorateProjectAssetMetadata(openScope);
  const openPartition = open.characterEligibilityPartition;
  assert.deepEqual(openPartition.pendingIds, ["C04", "C05"]);
  assert.ok(!openPartition.generationCandidateIds.includes("C05"), "pending never becomes a paid generation target");
  assert.deepEqual(openPartition.noAutomaticVisualIds, [], "open scope may not mark anything not_required");
});

test("the eligibility view never overwrites explicit character records", () => {
  // GPT §10.2/A15：原 castingTier / assetRequired / voiceLibraryId 不被自动改写。
  // 派生视图只新增兼容显示字段，不得把自动推断写回实体，也不得覆盖用户显式值。
  const project = projectFixture();
  project.characters[0].castingTier = "lead";
  project.characters[0].assetRequired = true;
  project.characters[0].voiceLibraryId = "voice_user_choice";
  project.characters[3].castingTier = "offscreen";
  project.characters[3].assetRequired = false;
  const explicitBefore = project.characters.map(item => ({
    id: item.id, castingTier: item.castingTier, assetRequired: item.assetRequired,
    voiceLibraryId: item.voiceLibraryId
  }));
  decorateProjectAssetMetadata(project);
  // A15 只保证「显式值不被自动改写」；允许新增只读兼容显示字段，
  // 但不允许把自动推断写成叙事层级，也不允许覆盖用户显式选择。
  for (const before of explicitBefore) {
    const after = project.characters.find(item => item.id === before.id);
    assert.equal(after.castingTier, before.castingTier, `${before.id} tier is not overwritten`);
    if (before.assetRequired !== undefined) {
      assert.equal(after.assetRequired, before.assetRequired, `${before.id} explicit assetRequired is preserved`);
    }
    assert.equal(after.voiceLibraryId, before.voiceLibraryId, `${before.id} voice binding is not overwritten`);
  }
  // 没有显式值的角色不得被自动补上叙事层级标签（GPT §10.2）。
  for (const id of ["C05", "C06", "C07"]) {
    assert.equal(project.characters.find(item => item.id === id).castingTier, undefined, id);
  }
});

test("compat assetRequired is display-only and never the execution condition", () => {
  const closed = projectFixture();
  closed.productionRevision = "R01";
  closed.sourceLockedAt = "2026-09-18T00:00:00.000Z";
  const project = decorateProjectAssetMetadata(closed);
  const view = id => project.characterEligibility.find(item => item.characterId === id);
  // required → true；unknown/needs_decision → null；not_required → false。
  assert.equal(project.characters.find(item => item.id === "C01").assetRequired, true);
  assert.equal(view("C01").visualRequirement, "required");
  assert.equal(project.characters.find(item => item.id === "C05").assetRequired, false);
  assert.equal(view("C05").visualRequirement, "not_required");
  // 兼容值绝不能把 unknown 说成 false —— 否则待核实项会从准入清单消失（GPT §4.3）。
  const open = decorateProjectAssetMetadata(projectFixture());
  const openView = id => open.characterEligibility.find(item => item.characterId === id);
  assert.equal(openView("C05").visualRequirement, "unknown");
  assert.equal(open.characters.find(item => item.id === "C05").assetRequired, null,
    "unknown is never stored as false");
  for (const character of open.characters) {
    const derived = openView(character.id);
    if (derived.visualRequirement === "unknown" || derived.visualRequirement === "needs_decision") {
      assert.equal(character.assetRequired, null, character.id);
    }
  }
});

test("legacy silver-haired named roles receive stable senior gender metadata and matching hair", () => {
  const woman = { id: "C20", name: "银发女士甲", role: "舞会来宾" };
  const representative = { id: "C21", name: "银发代表甲", role: "退休员工代表" };
  assert.equal(explicitCharacterGender(woman), "female");
  assert.equal(characterAgeBand(woman), "老年");
  assert.equal(explicitCharacterGender(representative), "male");
  assert.equal(characterAgeBand(representative), "老年");
  assert.match(deterministicAppearance(woman), /(?:银发|银灰|银白|白发|灰白|花白)/);
  assert.match(deterministicAppearance(representative), /(?:银发|银灰|银白|白发|灰白|花白)/);
});

test("only continuity-critical props remain; products, components, duplicates and one-shot paper stay out", () => {
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(projectFixture()));
  const selected = coreVisualProps(project);
  // GPT §5.4：coreVisualProps 只指独立道具通道需求。当前夹具里
  // 婚戒（摘下、跨镜）与审计文件（关键…证据）有真实独立外观证据；
  // 其余道具未证实独立资源路线 → needs_evidence，不进队列也不假装已解决。
  assert.deepEqual(selected.map(item => item.name), ["婚戒", "审计文件"]);
  for (const name of ["深灰色审计文件夹", "九宝茶", "独立茶包", "透明杯", "邀请券", "离婚协议"]) {
    const prop = project.assetLibraries.props.find(item => item.name === name);
    assert.equal(prop.assetRequired, null, name);
    assert.ok(prop.assetDecisionReason, name);
    assert.equal(prop.keepEntity, true, `${name} keeps its entity and story reference`);
  }
  // 待决策道具必须显式暴露给 UI 与阻塞清单，不能静默消失（GPT §4.2/Q4）。
  const pendingNames = propPendingDecisions(project).map(item =>
    project.assetLibraries.props.find(prop => prop.id === item.propId)?.name);
  for (const name of ["深灰色审计文件夹", "九宝茶", "独立茶包", "透明杯", "邀请券", "离婚协议"]) {
    assert.ok(pendingNames.includes(name), `${name} is exposed as pending`);
  }
  const oldTeaBagAsset = project.candidates.find(item => item.id === "A04");
  // GPT §5.4/Q4：needs_evidence 的旧绑定既不算已解决，也不能被静默销毁。
  // 它必须保留实体与绑定，由 pending 清单暴露，而不是伪造 true/false。
  assert.notEqual(oldTeaBagAsset.assetPolicyExcluded, true, "pending bindings are never silently excluded");
  assert.equal(oldTeaBagAsset.reusableAssetId, "asset_teabag_old", "pending bindings keep their reference");
});

test("a file and the folder that holds it are two entities, never merged by name or proximity", () => {
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(projectFixture()));
  const file = project.assetLibraries.props.find(item => item.name === "审计文件");
  const folder = project.assetLibraries.props.find(item => item.name === "深灰色审计文件夹");
  // GPT §5.1：容器—内容关系不等于同一物理物件。两个实体都保留。
  assert.equal(folder.assetMergedIntoId, null, "containment is not identity");
  assert.equal(folder.resourceRoute, "needs_evidence", "route must follow evidence, not name similarity");
  assert.equal(folder.keepEntity, true);
  assert.equal(file.keepEntity, true);
  assert.notEqual(file.id, folder.id);
});

test("a proven same-physical-object alias reuses the canonical asset and stays traceable", () => {
  const source = projectFixture();
  source.productionRevision = "R01";
  source.characterEligibilitySourceRevision = "R01";
  source.shotPlanRevision = "R01";
  source.policyVersion = "p1";
  source.assetLibraries.props.push({ id: "P09", name: "深灰证据夹", units: ["S05"], description: "与审计文件夹是同一个物理对象。" });
  // 应用内部已核验的同物记录：引用存在、来源可信、版本对应、目标同项目。
  source.confirmedSameObjectLinks = [{
    kind: "same_physical_object",
    fromId: "P09",
    toId: "P03",
    projectId: source.id,
    sourceRevision: "R01",
    evidenceId: "evidence_alias_001"
  }];
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(source));
  const alias = project.assetLibraries.props.find(item => item.id === "P09");
  // 别名证明齐全 → 可复用 canonical 资源，且关系可追溯（GPT §5.2）。
  assert.equal(alias.assetMergedIntoId, "P03");
  assert.equal(alias.canonicalPropId, "P03");
  assert.equal(alias.resourceRoute, "reuse");
  assert.equal(alias.visualRequirement, "required");
  assert.equal(propConsumerPlan(alias).generatePropCandidate, false, "reuse never opens a duplicate generation");
});

test("a bare confirmed boolean, name similarity or colour difference never merges props", () => {
  const source = projectFixture();
  source.assetLibraries.props.push({ id: "P10", name: "审计文件", units: ["S05"], description: "深灰色版本。" });
  source.candidates.push({ id: "A05", entityType: "library", entityId: "P10", stage: "prop_asset", selected: true, reusableAssetId: "asset_dup" });
  const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(source));
  const duplicate = project.assetLibraries.props.find(item => item.id === "P10");
  // 只有同名或颜色不同 → 不能自动合并（GPT §5.4）。
  assert.equal(duplicate.assetMergedIntoId, null);
  assert.equal(duplicate.keepEntity, true);
});

test("stale, cross-project, self-referential and cyclic same-object proofs are rejected without losing the entity", () => {
  const cases = [
    // 登记记录的 sourceRevision 与当前源版本不一致 → 过期证据。
    ["stale revision", { sourceRevision: "R02" }, {}],
    // 登记记录绑定的是别的项目 → 跨项目证据。
    ["cross-project target", { projectId: "other_project" }, {}],
    // 自环 → 不得合并。
    ["self merge", { fromId: "P09", toId: "P09" }, {}],
    // P09→P03 与 P03→P09 同时存在 → 多级环。
    ["cycle", {}, { aliases: [["P03", "P09"]] }]
  ];
  for (const [label, proofOverride, contextOverride] of cases) {
    const source = projectFixture();
    source.productionRevision = "R01";
    source.sourceLockedAt = "2026-09-18T00:00:00.000Z";
    source.assetLibraries.props.push({ id: "P09", name: "深灰证据夹", units: ["S05"] });
    source.confirmedSameObjectLinks = [
      {
        kind: "same_physical_object", fromId: "P09", toId: "P03",
        projectId: source.id, sourceRevision: "R01", evidenceId: "evidence_alias_001",
        ...proofOverride
      },
      ...(contextOverride.aliases || []).map(([fromId, toId]) => ({
        kind: "same_physical_object", fromId, toId,
        projectId: source.id, sourceRevision: "R01", evidenceId: `evidence_${fromId}`
      }))
    ];
    const project = deactivateIneligibleProjectAssetBindings(decorateProjectAssetMetadata(source));
    const alias = project.assetLibraries.props.find(item => item.id === "P09");
    assert.ok(alias, `${label}: entity is never dropped`);
    assert.equal(alias.keepEntity, true, `${label}: entity is kept`);
    assert.notEqual(alias.assetMergedIntoId, "P03", `${label}: invalid proof never merges`);
    assert.equal(alias.resourceRoute, "needs_decision", `${label}: invalid proof is surfaced as needs_decision`);
  }
});

test("the bundled pack contains 40 distinct playable WAV voices across genders and ages", () => {
  assert.equal(voiceManifest.voices.length, 40);
  const ids = new Set();
  const hashes = new Set();
  const genders = { male: 0, female: 0 };
  const ages = { 青年: 0, 中年: 0, 老年: 0 };
  for (const voice of voiceManifest.voices) {
    assert.ok(!ids.has(voice.id), voice.id);
    ids.add(voice.id);
    genders[voice.gender] += 1;
    ages[voice.ageBand] += 1;
    const filePath = path.join(voicePackDir, voice.file);
    assert.ok(fs.existsSync(filePath), voice.file);
    hashes.add(crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"));
    const audit = auditVoiceFile(filePath);
    assert.equal(audit.ok, true, voice.file);
    assert.ok(audit.duration > 0.5, voice.file);
  }
  assert.equal(hashes.size, 40);
  assert.ok(genders.male >= 16);
  assert.ok(genders.female >= 16);
  assert.ok(ages.青年 >= 8);
  assert.ok(ages.中年 >= 8);
  assert.ok(ages.老年 >= 8);
});

test("a fresh store protects 40 built-in voices and never marks low-confidence acoustic gender as verified", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-voice-pack-v118-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const voices = store.listVoiceLibrary();
  assert.equal(voices.length, 40);
  assert.equal(voices.filter(item => item.builtIn === true).length, 40);
  assert.equal(voices.filter(item => item.profileVerified === true).length, 39);
  const pending = voices.filter(item => item.profileVerified !== true);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "builtin_voice_40");
  assert.equal(pending[0].profileVerificationSource, "curated-source-pending-acoustic");
  assert.throws(() => store.deleteVoiceLibraryEntry("builtin_voice_01"), error => error?.code === "BUILTIN_VOICE_DELETE_FORBIDDEN");
});

test("confirmed core asset candidates receive durable reverse links to the reusable library", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-reusable-asset-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("asset link fixture");
  const filePath = path.join(store.assetDir(project.id, "characters"), "lead.png");
  fs.writeFileSync(filePath, Buffer.from("lead-image"));
  const mutable = store.getProject(project.id);
  mutable.productionRevision = "R01";
  mutable.characters = [{ id: "C01", name: "顾云舟", gender: "male", ageBand: "中年", castingTier: "lead", assetRequired: true }];
  store.saveProject(mutable);
  const candidate = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_intro",
    productionRevision: "R01",
    filePath,
    selected: true
  });
  const links = store.linkConfirmedProjectAssetsToLibrary(project.id);
  const persisted = store.getProject(project.id).candidates.find(item => item.id === candidate.id);
  assert.equal(links.length, 1);
  assert.match(persisted.reusableAssetId, /^asset_/);
  assert.equal(store.readReusableAssetLibrary().some(item => item.id === persisted.reusableAssetId && item.gender === "male" && item.castingTier === "lead"), true);
});

test("confirming a new portrait does not stale an independently materialized library voice", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puream-independent-library-voice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkbenchStore(root);
  const project = store.createProject("independent voice fixture");
  const mutable = store.getProject(project.id);
  mutable.productionRevision = "R01";
  mutable.characters = [{ id: "C01", name: "银发代表甲", gender: "male", ageBand: "老年", assetRequired: true, voiceAssetRequired: true }];
  store.saveProject(mutable);

  const voicePath = path.join(store.assetDir(project.id, "audio"), "voice.wav");
  fs.copyFileSync(path.join(voicePackDir, voiceManifest.voices[0].file), voicePath);
  const voice = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_voice",
    source: "voice-library",
    voiceLibraryId: voiceManifest.voices[0].id,
    filePath: voicePath,
    selected: true
  });
  const portraitPath = path.join(store.assetDir(project.id, "characters"), "portrait.png");
  fs.writeFileSync(portraitPath, Buffer.from("portrait"));
  const portrait = store.addCandidate(project.id, {
    entityType: "character",
    entityId: "C01",
    stage: "character_intro",
    filePath: portraitPath
  });
  store.confirmCandidate(project.id, portrait.id, false);

  const persisted = store.getProject(project.id).candidates.find(item => item.id === voice.id);
  assert.equal(persisted.stale, undefined);
  assert.equal(persisted.selected, true);
});

test("prompt review only enumerates asset-bearing people, required voices and core assets", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const start = workflow.indexOf("async preparePromptReviewBundle(projectId, options = {})");
  const end = workflow.indexOf("async requestPromptReview", start);
  assert.ok(start >= 0 && end > start);
  const source = workflow.slice(start, end);
  assert.match(source, /reviewCharacterIds = new Set\(assetBearingCharacters\(project\)/);
  assert.match(source, /if \(!reviewCharacterIds\.has\(String\(character\.id \|\| ""\)\)\) return character/);
  assert.match(source, /reviewVoiceIds = new Set/);
  assert.match(source, /reviewPropIds = new Set\(coreVisualProps\(project\)/);
  assert.match(source, /libraryType === "props" && !reviewPropIds\.has/);
  assert.match(source, /libraryType === "wardrobes" && entry\.changeRequired === false/);
});

test("renderer exposes asset eligibility, verified voice tags and casting filters", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(renderer, /character\.assetRequired === true/);
  assert.match(renderer, /item\.assetRequired === true/);
  assert.match(renderer, /声纹标签已核验/);
  assert.match(renderer, /内置音色/);
  assert.match(renderer, /data-reusable-asset-filter="castingTier"/);
  assert.match(renderer, /未建立独立资产/);
  assert.match(renderer, /已跳过 .*非核心物品/);
});
