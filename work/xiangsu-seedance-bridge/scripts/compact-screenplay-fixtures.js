'use strict';
// Shared fixtures for the compact-screenplay family of regressions.
//
// These helpers used to live inside compact-screenplay.test.js, so any file
// that needed them had to require() a test module. Node registers that
// module's top-level test() calls as subtests of the requiring test, which
// made unrelated suites fail with "did not finish before its parent".
// Keep fixtures in a plain module and let test files import only this.
const writer = require('../app/shot-screenplay');

function fixture() {
  const d = require('./shot-screenplay-fixture').fixture();
  return {
    format: 'compact-screenplay-v2',
    story: d.story,
    characters: d.characters.map(({ id, name, description, assetRequired, role, voiceDescription }) => ({ id, name, description, assetRequired, role, voiceDescription })),
    scenes: d.scenes.map(({ id, name, description, assetRequired }) => ({ id, name, description, assetRequired })),
    props: [],
    shots: d.shots.map(({ wardrobeBindings, beats, transition, sound, ...s }) => ({ ...s, action: beats.map(b => b.action).join('\n'), dialogue: s.dialogue.map(({ start, end, ...t }) => t) }))
  };
}

function project(mode) {
  const d = fixture(), raw = writer.render(d), record = writer.makeRecord(d, raw, {}), data = writer.projectData(record);
  return { ...data, id: 'compact-test', script: { raw, shotScreenplay: record }, generation: { engine: 'hailuo-h3', mode }, product: {}, assetLibraries: { props: data.props, wardrobes: data.wardrobes } };
}

function decision(s) {
  return {
    shotId: s.id,
    identityContractVersion: 1,
    duration: 12,
    visibleCharacterIds: s.visibleCharacterIds,
    visiblePropIds: s.propIds,
    productVisible: s.productVisible,
    states: s.visibleCharacterIds.map(characterId => ({ characterId, openingEn: 'Seated beside the table.', openingZh: '坐在桌旁。', endingEn: 'Still seated.', endingZh: '仍坐原位。' })),
    environmentEn: 'Living room, north window.',
    environmentZh: '有北窗的客厅。',
    objectStates: [],
    events: [{ id: 'E01', actorIds: s.visibleCharacterIds, offscreenActorIds: [], propIds: [], usesProduct: false, start: 0, end: 12, after: [], continuityActionIds: [], throughoutDialogueIds: [], recordedSpeech: null, descriptionEn: 'The daughter looks toward her mother, who listens.', descriptionZh: '女儿看着母亲，母亲倾听。' }],
    cameras: [{ at: 0, size: 'medium', angle: 'front', movement: 'locked', subjectIds: s.visibleCharacterIds }],
    dialogue: s.dialogue.map(d => ({ id: d.id, start: .3, end: 2, listenerIds: d.listenerIds, addressMode: d.addressMode, deliveryEn: 'Warm and clear natural female voice.', deliveryZh: d.delivery })),
    summaryEn: 'Daughter greets mother.',
    soundscapeEn: 'Quiet room ambience.'
  };
}

module.exports = { fixture, project, decision };
