'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shotVideoPropBindings, shotVideoProductReferenceRequired, promptReviewReferencePlan, WorkbenchWorkflow } = require('../app/workbench-workflow');
const inventory = require('../app/source-prop-inventory');

function fixture() {
  const shot = { id: 'S01', number: 1, action: '信纸保持收存在内袋里，演员握住笔记本。', stateAfter: '', propNames: ['信纸', '笔记本'], propBindings: [{ propId: 'P1' }], characterIds: [], sceneId: '', dialogueTurns: [] };
  const project = { id: 'project', script: { raw: 'reference fixture' }, generation: { engine: 'hailuo-h3', mode: 'asset_direct' }, characters: [], scenes: [], shots: [shot], product: {}, candidates: [], assetLibraries: { props: [
    { id: 'P1', name: '信纸', assetRequired: true, sourceInventory: { appearances: [{ shotId: 'S01', visibility: 'stored', evidence: '信纸保持收存在内袋里' }] } },
    { id: 'P2', name: '笔记本', assetRequired: true, sourceInventory: { appearances: [{ shotId: 'S01', visibility: 'visible', evidence: '演员握住笔记本' }] } },
    { id: 'P3', name: '照片', assetRequired: true, sourceInventory: { appearances: [{ shotId: 'S02', visibility: 'visible', evidence: '照片' }] } }
  ] } };
  project.sourcePropInventory = { status: 'completed', fingerprint: inventory.fingerprint(project) };
  return { project, shot };
}

test('current source occurrence evidence overrides stored prop names and explicit continuity bindings', () => {
  const { project, shot } = fixture();
  shot.stateBefore = '照片仍在上一场的柜子里。';
  project.sourcePropInventory.fingerprint = inventory.fingerprint(project);
  assert.deepEqual(shotVideoPropBindings(project, shot).map(p => p.propId), ['P2']);
  assert.deepEqual(promptReviewReferencePlan(project, shot, 'asset_direct').imageRoles.map(r => r.entityId), ['P2']);
});

test('a prop stored then taken out within this shot remains a visible reference', () => {
  const { project, shot } = fixture();
  shot.action += '随后取出信纸。';
  project.assetLibraries.props[0].sourceInventory.appearances.push({ shotId: 'S01', visibility: 'visible', evidence: '取出信纸' });
  project.sourcePropInventory.fingerprint = inventory.fingerprint(project);
  assert.deepEqual(shotVideoPropBindings(project, shot).map(p => p.propId), ['P1', 'P2']);
});

test('obsolete occurrence evidence must not suppress a newly visible prop', () => {
  const { project, shot } = fixture();
  project.script.raw = 'changed source';
  shot.action = '演员拿出信纸。';
  assert.ok(shotVideoPropBindings(project, shot).some(p => p.propId === 'P1'));
});

test('runtime manifest does not reintroduce a stored-only prop through the propNames fallback', () => {
  const { project, shot } = fixture();
  shot.propNames = ['信纸']; shot.action = '信纸保持收存在内袋里。';
  project.assetLibraries.props[1].sourceInventory.appearances = [];
  project.sourcePropInventory.fingerprint = inventory.fingerprint(project);
  const wf = new WorkbenchWorkflow({ store: { getSettings: () => ({ videoProvider: {} }) }, bridge: {} });
  assert.equal(promptReviewReferencePlan(project, shot, 'asset_direct').imageRoles.length, 0);
  shot.sceneId = 'SC1'; project.scenes = [{ id: 'SC1', name: 'fixture set' }];
  project.sourcePropInventory.fingerprint = inventory.fingerprint(project);
  // File-handle fixture only: this test does not generate or inspect media.
  project.candidates = [{ id: 'scene-fixture', entityType: 'scene', entityId: 'SC1', stage: 'scene_asset', filePath: __filename, selected: true }];
  const refs = wf.shotReferences(project, shot, 'asset_direct', { hailuoReferenceAudioMode: 'image_only' });
  assert.deepEqual(refs.imageRoles.map(r => r.type), ['scene']);
});

test('product name split by packaging typography still binds the exact original image', () => {
  const project = { product: { name: '示例黄精五黑膏', imagePath: 'original.png' } };
  assert.equal(shotVideoProductReferenceRequired(project, { productMention: true, action: '演员托握未开封的罐，正面标签为“示例/黄精/五黑膏”。' }), true);
});

test('subsequent original-package handling binds product without repeating its complete name', () => {
  const project = { product: { name: '示例黄精五黑膏', imagePath: 'original.png' } };
  for (const action of ['演员双手托握未旋开的原装罐，向老人展示。', '她握住未旋开的原装广口罐，捧起并托稳。']) {
    assert.equal(shotVideoProductReferenceRequired(project, { productMention: true, action, productBinding: { source: 'user_uploaded_product', name: project.product.name } }), true);
  }
});

test('spoken product name and hidden original packaging cannot create a visible reference', () => {
  const project = { product: { name: '示例黄精五黑膏' } };
  for (const action of ['原装广口罐始终收在袋内，没有入镜。演员指向桌面的水杯。', '演员端起一只咖啡罐。']) {
    assert.equal(shotVideoProductReferenceRequired(project, { productMention: true, action, dialogue: project.product.name, productBinding: { source: 'user_uploaded_product', name: project.product.name } }), false);
  }
});

test('original package visibly supported on a surface and touched packaging parts retain identity', () => {
  const project = { product: { name: '示例黄精五黑膏', visualEvidence: { status: 'observed', containerType: '带旋盖的广口罐' } } };
  for (const action of ['原装广口罐始终密封留在床头柜上，标签完整。', '未旋开的原装罐仍妥善留在桌面上。', '老人手指离开旋盖，转而查看照片。']) {
    assert.equal(shotVideoProductReferenceRequired(project, { productMention: true, action, productBinding: { source: 'user_uploaded_product', name: project.product.name } }), true);
  }
});
