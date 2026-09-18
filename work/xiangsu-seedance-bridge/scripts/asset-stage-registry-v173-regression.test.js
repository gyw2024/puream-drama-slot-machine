'use strict';
// §9.4 回归：资产阶段白名单来自单一来源注册表；
// 未知 stage 返回待验证；「背景规则不适用」不得冒充「所有质量要求已通过」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const registry = require('../app/asset-stage-registry');
const passport = require('../app/foundry/asset-passport');

test('注册表是唯一来源，包含全部已知资产阶段且无重复', () => {
  assert.ok(registry.ALL_ASSET_STAGES.length >= 13);
  assert.equal(new Set(registry.ALL_ASSET_STAGES).size, registry.ALL_ASSET_STAGES.length, '不得重复');
  for (const stage of [
    'character_intro', 'character_sheet', 'character_three_view',
    'scene_asset', 'prop_asset', 'wardrobe_asset', 'product_asset',
    'character_voice', 'voice_asset', 'character_video', 'shot_video',
    'storyboard_still', 'storyboard_sheet'
  ]) {
    assert.ok(registry.ALL_ASSET_STAGES.includes(stage), `注册表缺少 ${stage}`);
  }
});

test('护照模块不再手抄 stage 名单，改为引用注册表', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app', 'foundry', 'asset-passport.js'), 'utf8');
  assert.match(source, /require\('\.\.\/asset-stage-registry'\)/, '须引用共享注册表');
  assert.doesNotMatch(source, /const KNOWN_ASSET_STAGES = Object\.freeze\(new Set\(\[/,
    '不得再手抄 KNOWN_ASSET_STAGES 字面量集合');
  // isKnownStage 的判定必须委托给注册表，不得在本模块内自行实现前缀/名单逻辑。
  const start = source.search(/function isKnownStage\s*\(/);
  const end = source.search(/function buildPassport\s*\(/);
  assert.ok(start > 0 && end > start, `须能定位 isKnownStage 函数体（start=${start} end=${end}）`);
  const isKnownStageBody = source.slice(start, end);
  assert.match(isKnownStageBody, /isKnownAssetStage/, 'isKnownStage 须委托注册表');
  assert.doesNotMatch(isKnownStageBody, /startsWith|KNOWN_ASSET_STAGES\.has/,
    'isKnownStage 不得在本模块内自行实现名单/前缀判定');
});

test('未知 stage 返回 needs_validation，不被当成通过也不被静默放行', () => {
  const built = passport.buildPassport(
    { id: 'p1', productionRevision: 'r1' },
    { id: 'c1', entityType: 'character', entityId: 'C1', stage: 'not_a_stage', filePath: '', createdAt: '2026-01-01' },
    null,
    {}
  );
  assert.equal(built.status, 'needs_validation');
  assert.ok(built.issues.includes('unknown_asset_stage'));
  assert.equal(built.active, false, '未知 stage 不得被判为 active');
  assert.equal(built.quality.uniformBackgroundVerified, null, '未知 stage 的背景规则不适用，须为 null');
  assert.equal(built.quality.fixedBackgroundColor, '');
});

test('storyboard_ 前缀族视为已知（新增族成员不需改护照）', () => {
  assert.equal(registry.isKnownAssetStage('storyboard_keyframe'), true);
  assert.equal(registry.isKnownAssetStage('storyboard_take_sheet'), true);
  assert.equal(registry.isKnownAssetStage('storyboard_'), true);
  assert.equal(registry.isKnownAssetStage(''), false);
  assert.equal(registry.isKnownAssetStage('character_sheet_typo'), false);
});

test('背景规则只适用于人物四视图：不适用 ≠ 已通过', () => {
  assert.equal(registry.requiresUniformCharacterBackground('character_sheet'), true);
  assert.equal(registry.requiresUniformCharacterBackground('character_three_view'), true);
  assert.equal(registry.requiresUniformCharacterBackground('scene_asset'), false);
  assert.equal(registry.requiresUniformCharacterBackground('prop_asset'), false);

  // 场景资产：背景规则不适用，但这不是「所有质量要求已通过」。
  const scene = passport.buildPassport(
    { id: 'p1', productionRevision: 'r1' },
    { id: 's1', entityType: 'scene', entityId: 'S1', stage: 'scene_asset', filePath: '', createdAt: '2026-01-01' },
    null,
    {}
  );
  assert.equal(scene.quality.uniformBackgroundVerified, null, '不适用阶段须为 null，而非「已验证通过」');
  assert.equal(scene.quality.fixedBackgroundColor, '');
  // 且必须仍有其它真实门禁在起作用：文件缺失使状态不为 eligible。
  assert.equal(scene.status, 'missing');
  assert.ok(scene.issues.includes('asset_file_missing'));
});

test('人物四视图：背景未验证时是 review_required 而非 eligible', () => {
  // 用一个真实存在的文件路径，隔离出背景这一唯一变量。
  const realFile = path.join(ROOT, 'package.json');
  const unverified = passport.buildPassport(
    { id: 'p1', productionRevision: 'r1' },
    { id: 'c1', entityType: 'character', entityId: 'C1', stage: 'character_sheet', filePath: realFile, createdAt: '2026-01-01', qualityAudit: { ok: true } },
    null,
    {}
  );
  assert.equal(unverified.status, 'review_required');
  assert.ok(unverified.issues.includes('uniform_background_not_verified'));

  const verified = passport.buildPassport(
    { id: 'p1', productionRevision: 'r1' },
    { id: 'c2', entityType: 'character', entityId: 'C1', stage: 'character_sheet', filePath: realFile, createdAt: '2026-01-01', qualityAudit: { ok: true, uniformBackground: true } },
    null,
    {}
  );
  assert.equal(verified.status, 'eligible');
});

test('合法四视图阶段的背景色取自合同，而非硬编码旁路', () => {
  const realFile = path.join(ROOT, 'package.json');
  const contract = { policies: { characterSheet: { background: { fixedColor: '#E9E9E9' } } } };
  const built = passport.buildPassport(
    { id: 'p1', productionRevision: 'r1' },
    { id: 'c1', entityType: 'character', entityId: 'C1', stage: 'character_three_view', filePath: realFile, createdAt: '2026-01-01' },
    null,
    contract
  );
  assert.equal(built.quality.fixedBackgroundColor, '#E9E9E9');
  assert.equal(built.status, 'review_required');
});
