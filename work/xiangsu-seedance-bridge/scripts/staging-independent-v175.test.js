"use strict";

// Independent, synthetic forward tests. No network, media generation, or live
// projects are read or changed. Evidence is scoped to this task's scratch area.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");
const { promptReviewReferencePlan, canonicalShotForVideoPrompt } = require("../app/workbench-workflow");
const { promptTimeline, performanceTimelineFailures } = require("../app/drama-performance-timeline");
const staging = require("../app/drama-staging-contract");

const MODES = ["asset_direct", "keyframe", "storyboard_sheet", "continuation", "production_package"];
const EVIDENCE = path.resolve(__dirname, "../.codex_tests/TASK-20260905-STAGING-SOUND-175/independent", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const observations = [];
const clone = value => JSON.parse(JSON.stringify(value));
const cleanId = value => String(value).replace(/[^a-z0-9_-]/gi, "-");

function subjectFor(prompt, characterId) {
  const line = String(prompt).split("\n").find(row => row.startsWith("<Subject ") && row.includes(`character ${characterId}`));
  assert.ok(line, `no subject definition for ${characterId}`);
  return line.match(/^<Subject \d+>/)[0];
}

function spokenEvent(prompt, text) {
  const items = promptTimeline(prompt).filter(item => item.text === text);
  assert.equal(items.length, 1, `exact dialogue event count for ${text}`);
  return items[0];
}

function assertSpeakerFacing(event, speaker, target, wrong) {
  const spokenPrefix = event.line.slice(0, event.line.indexOf("<d>"));
  assert.ok(spokenPrefix.includes(`${speaker} (S1) faces ${target}`), `wrong spoken addressee: ${spokenPrefix}`);
  // A [Shot] line also contains the listener's reaction, third-person actions,
  // camera motion and before/after states. Those may target a different person.
  // Inspect only this speaker's own explicitly compiled facing/eyeline field.
  const facing = event.line.match(/facing and eyeline are\s+([\s\S]*?)(?=\s+Only <Subject \d+>\s*\(S\d+\)|$)/i)?.[1];
  assert.ok(facing, "compiled speaker facing/eyeline field is missing");
  assert.ok(facing.includes(speaker) && facing.includes(target), `speaker or intended addressee missing from facing clause: ${facing}`);
  assert.ok(!facing.includes(wrong), `wrong person in the speaker's facing/eyeline clause: ${facing}`);
}

function saveEvidence(label, value) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${cleanId(label)}.json`), JSON.stringify(value, null, 2));
}

function render(fixture, label, options = {}) {
  const input = { project: fixture.project, shot: fixture.shot, references: fixture.references, dialogueTurns: fixture.shot.dialogueTurns, ...options };
  try {
    const prompt = buildApprovedHailuoPrompt(input);
    saveEvidence(label, { input, prompt, timeline: promptTimeline(prompt), timingFailures: performanceTimelineFailures(fixture.shot, prompt) });
    observations.push({ label, compiled: true, length: prompt.length });
    return prompt;
  } catch (error) {
    saveEvidence(label, { input, error: { message: error.message, code: error.code, failures: error.failures } });
    observations.push({ label, compiled: false, code: error.code, message: error.message });
    throw error;
  }
}

function fixture(mode = "asset_direct") {
  const project = {
    id: "independent-staging-only", generation: { mode, videoApiMode: mode === "keyframe" ? "image_to_video" : "reference_to_video", aspectRatio: "9:16" },
    characters: [{ id: "C01", name: "林岚" }, { id: "C02", name: "周强" }, { id: "C03", name: "赵敏" }],
    scenes: [{ id: "SC01", name: "客厅", description: "One living room with the front door at rear-right and a wooden table at center." }],
    assetLibraries: { wardrobes: [], props: [] }, candidates: [], shots: []
  };
  const shot = {
    id: "S01", number: 1, sceneId: "SC01", duration: 12,
    characterIds: ["C03", "C01", "C02"], visibleCharacterIds: ["C03", "C01", "C02"],
    actionEn: "C02 places the unopened parcel on the wooden table. C03 checks its broken seal, then turns toward C01. C01 lifts the receipt and reveals the matching address.",
    stateBeforeEn: "C01 holds screen-left by the table. C02 holds screen-center. C03 holds screen-right near the rear doorway.",
    stateAfterEn: "The parcel lies on the table with its broken seal visible. C01 holds the receipt; C02 and C03 remain on their established marks.",
    subshots: [
      { number: 1, start: 0, end: 5.5, visibleCharacterIds: ["C01", "C02", "C03"], actionEn: "C02 places the unopened parcel on the table; C03 turns the broken seal toward C01.", cameraEn: "Medium three-shot from the established side of the table, pushing toward C02.", soundEn: "Continuous quiet room tone. At 0.8 seconds the parcel contacts the wooden tabletop with one short dull thump." },
      { number: 2, start: 5.5, end: 12, visibleCharacterIds: ["C01", "C02", "C03"], actionEn: "C03 points once to the broken parcel seal; C01 lifts the matching receipt into view.", cameraEn: "Direct cut to a readable three-quarter medium close-up of C03, with C01 visible to screen-left.", soundEn: "Continuous quiet room tone. At 9.7 seconds C01 lifts the receipt with one brief dry paper rustle." }
    ],
    dialogueTurns: [
      { sourceDialogueId: "D001", speakerId: "C02", listenerIds: ["C03"], onScreen: true, start: 1.4, end: 4.2, text: "赵阿姨，包裹的封条到这里就开了。", speechRateCps: 5, subshotNumber: 1,
        deliveryEn: "Uneasy measured explanation with stress on the broken seal.", vocalArcEn: "Start low; the broken seal triggers a pitch lift; peak on the place of discovery; end with restrained pressure.", facialPerformanceEn: "Brows start raised; eyes lock on C03 at the seal; jaw tightens at the discovery; lips settle after the last word.", bodyActionEn: "C02 keeps one open palm beside the parcel and turns the torso toward C03.", blockingEn: "C02 holds screen-center facing C03 at screen-right; C01 remains screen-left.", speakerFacingEn: "C02 points face, torso and eyeline toward C03 in readable three-quarter profile.", eyelineEn: "C02 looks toward C03 at screen-right.", listenerReactionEn: "C03 keeps lips closed, tilts the seal toward the light and then fixes the eyes on C01." },
      { sourceDialogueId: "D002", speakerId: "C03", listenerIds: ["C01"], onScreen: true, start: 6.2, end: 9, text: "林岚，你看收件地址是不是写错了。", speechRateCps: 5, subshotNumber: 2,
        deliveryEn: "Concerned clear question with firm stress on the address.", vocalArcEn: "Start contained; sight of the damaged seal triggers a rise; peak on the address; resolve into a clipped complete ending.", facialPerformanceEn: "Brows draw inward; eyes turn from the seal to C01; jaw sets at the address; the stare holds after the question.", bodyActionEn: "C03 points to the label with the right index finger while keeping the torso toward C01.", blockingEn: "C03 remains screen-right facing C01 at screen-left; C02 stays screen-center behind the table.", speakerFacingEn: "C03 turns face, torso and eyeline toward C01 at screen-left, preserving the established axis.", eyelineEn: "C03 looks toward C01 at screen-left.", listenerReactionEn: "C01 remains closed-lipped, raises the receipt to compare the address and then nods once." }
    ]
  };
  project.shots = [shot];
  const temporal = mode === "keyframe" ? [{ type: "storyboard_start", entityId: "S01" }, { type: "storyboard_end", entityId: "S01" }]
    : mode === "storyboard_sheet" ? [{ type: "storyboard_sheet", entityId: "S01" }] : [];
  const imageRoles = [...temporal, { type: "scene", entityId: "SC01" }, ...["C03", "C01", "C02"].map(entityId => ({ type: "character", entityId }))];
  const references = { promptMode: mode, imageRoles, images: imageRoles.map((_, i) => `fixture-image-${i}`), audios: [], videos: mode === "continuation" ? ["fixture-previous-video"] : [], videoRoles: mode === "continuation" ? [{ type: "previous_shot", entityId: "S00" }] : [] };
  return { project, shot, references };
}

for (const mode of MODES) {
  test(`${mode}: three identities preserve changing addressee and first-vocal numbering`, () => {
    const f = fixture(mode);
    const prompt = render(f, `${mode}-three-person`);
    const c01 = subjectFor(prompt, "C01"), c02 = subjectFor(prompt, "C02"), c03 = subjectFor(prompt, "C03");
    for (const [i, speaker, listener, number] of [[0, c02, c03, 1], [1, c03, c01, 2]]) {
      const event = spokenEvent(prompt, f.shot.dialogueTurns[i].text);
      assert.ok(event.line.includes(`${speaker} (S${number}) faces ${listener}`), event.line);
      assert.ok(event.line.includes(`Only ${speaker} (S${number}) moves the lips`), event.line);
      assert.equal(event.speechStart, f.shot.dialogueTurns[i].start);
      assert.equal(event.speechEnd, f.shot.dialogueTurns[i].end);
    }
    assert.deepEqual(performanceTimelineFailures(f.shot, prompt), []);
  });

  test(`${mode}: conflicting addressed listener cannot silently reach executable prompt`, () => {
    const f = fixture(mode);
    const turn = f.shot.dialogueTurns[0];
    turn.speakerFacingEn = "C02 turns face, torso and eyeline toward C01 at screen-left.";
    turn.eyelineEn = "C02 looks to C01 at screen-left.";
    let prompt;
    try { prompt = render(f, `${mode}-listener-conflict`); }
    catch (error) { assert.match(`${error.code} ${error.message}`, /listener|facing|eyeline|staging|target|performance|冲突|听者/i); return; }
    const event = spokenEvent(prompt, turn.text);
    assertSpeakerFacing(event, subjectFor(prompt, "C02"), subjectFor(prompt, "C03"), subjectFor(prompt, "C01"));
  });

  test(`${mode}: multiple silent listeners retain exactly the authored primary eyeline target`, () => {
    const f = fixture(mode);
    f.shot.dialogueTurns[0].listenerIds = ["C01", "C03"];
    f.shot.dialogueTurns[0].primaryListenerId = "C03";
    const prompt = render(f, `${mode}-primary-listener`);
    const event = spokenEvent(prompt, f.shot.dialogueTurns[0].text);
    const speaker = subjectFor(prompt, "C02"), target = subjectFor(prompt, "C03"), bystander = subjectFor(prompt, "C01");
    const prefix = event.line.slice(0, event.line.indexOf("<d>"));
    assert.ok(prefix.includes(`${speaker} (S1) faces ${target}`), `primary addressee not preserved: ${prefix}`);
    assert.ok(!prefix.includes(`faces ${bystander}`) && !prefix.includes(`${target} and ${bystander}`), `listener-array order became a multi-target facing direction: ${prefix}`);
  });

  test(`${mode}: phone reply never materializes the offscreen speaker or animates a visible mouth`, () => {
    const f = fixture(mode);
    f.project.characters.push({ id: "C04", name: "电话客服", offscreenOnly: true, assetRequired: false });
    f.shot.characterIds.push("C04");
    const turn = f.shot.dialogueTurns[1];
    Object.assign(turn, { speakerId: "C04", listenerIds: ["C01"], onScreen: false, speechChannel: "phone", text: "林女士，系统里留的就是这个地址。", bodyActionEn: "C04 remains outside the frame; no part of the body is visible.", facialPerformanceEn: "C04 is heard only through the phone; the face is outside the frame and not visible.", speakerFacingEn: "C04 is outside the frame and not visible.", eyelineEn: "C04 is outside the frame and has no visible eyeline.", blockingEn: "C04 remains absent from the visible cast; C01 listens to the phone held in the right hand.", listenerReactionEn: "C01 holds the phone beside the right ear and lowers the receipt with lips fully closed." });
    const prompt = render(f, `${mode}-phone-reply`);
    const event = spokenEvent(prompt, turn.text);
    const subject = subjectFor(prompt, "C04");
    assert.ok(event.line.includes(`${subject} (S2) remains off-screen`));
    assert.match(event.line, /No visible mouth moves/i);
    assert.ok(!event.line.includes(`Only ${subject} (S2) moves the lips`));
    const definition = prompt.split("\n").find(line => line.startsWith(subject));
    assert.doesNotMatch(definition, /<Picture \d+>/);
  });

  test(`${mode}: explicit offscreen source discards contradictory visible facial performance`, () => {
    const f = fixture(mode);
    f.shot.dialogueTurns[0].onScreen = false;
    let prompt;
    try { prompt = render(f, `${mode}-stale-offscreen`); }
    catch (error) { assert.match(`${error.code} ${error.message}`, /visibility|on.?screen|off.?screen|staging|performance|出镜|画外/i); return; }
    const event = spokenEvent(prompt, f.shot.dialogueTurns[0].text);
    assert.ok(event.line.includes("remains off-screen"), "explicit source offscreen ownership changed");
    assert.doesNotMatch(event.line, /Brows start raised|eyes lock on|jaw tightens at the discovery/, `Offscreen voice retained a visible face: ${event.line}`);
  });

  test(`${mode}: wardrobe reference remains attached to its wearer in actual review plan`, () => {
    const f = fixture(mode);
    f.project.assetLibraries.wardrobes.push({ id: "W01", characterId: "C01", name: "wet red jacket", changeRequired: true, units: ["S01", "S02"] });
    f.shot.wardrobeBindings = [{ characterId: "C01", wardrobeId: "W01", continuity: "wet red jacket begins here" }];
    const plan = promptReviewReferencePlan(f.project, f.shot, mode, "image_only");
    saveEvidence(`${mode}-wardrobe-review-plan`, plan);
    const role = (plan.hailuoApiMode === "image_to_video" ? plan.frameSourceImageRoles : plan.imageRoles).find(item => item.type === "wardrobe" && item.entityId === "W01");
    assert.ok(role, "current appearance asset dropped from review plan");
    assert.equal(role.characterId, "C01", "wardrobe reference lost its owning identity before compilation");
  });

  test(`${mode}: activated wardrobe persists to next same-scene shot without base-portrait reset`, () => {
    const f = fixture(mode);
    f.project.assetLibraries.wardrobes.push({ id: "W01", characterId: "C01", name: "wet red jacket", changeRequired: true, activationShotId: "S01", continuityEndShotId: "S03", units: ["S01", "S02", "S03"] });
    f.shot.wardrobeBindings = [{ characterId: "C01", wardrobeId: "W01", continuity: "C01 wears the wet red jacket after entering" }];
    f.shot.stateAfterEn += " C01 remains in the wet red jacket.";
    const next = clone(f.shot);
    Object.assign(next, { id: "S02", number: 2, wardrobeBindings: [], stateBeforeEn: "Continue the parcel inspection on the established marks." });
    f.project.shots.push(next);
    const canonical = canonicalShotForVideoPrompt(f.project, next);
    const plan = promptReviewReferencePlan(f.project, canonical, mode, "image_only");
    saveEvidence(`${mode}-wardrobe-continuity`, { canonical, plan });
    assert.ok((plan.hailuoApiMode === "image_to_video" ? plan.frameSourceImageRoles : plan.imageRoles).some(item => item.type === "wardrobe" && item.entityId === "W01" && item.characterId === "C01"), "active wardrobe disappeared from next-shot frame source or reference plan");
  });

  test(`${mode}: actor-held product detail retains both handoff identities in reference plan`, () => {
    const f = fixture(mode);
    f.project.product = { name: "测试商品盒", assetId: "asset_product", imagePath: "fixture-product-original.png" };
    Object.assign(f.shot, {
      productMention: true, productShotType: "product_detail", shotFunction: "product_detail",
      characterIds: ["C03", "C01"], visibleCharacterIds: ["C03", "C01"],
      action: "赵敏右手拿着商品盒递给林岚，林岚左手接稳后转向标签；镜头从同一只持盒手切近景再回到二人。",
      actionEn: "C03 holds the exact product carton in the right hand and transfers it to C01's left hand. C01 turns the label toward the camera. The detail cut originates on the same held carton and returns to C01 holding it.",
      productBinding: { productAssetId: "asset_product", holderCharacterId: "C03", holderBeforeCharacterId: "C03", holderAfterCharacterId: "C01", hand: "right", handAfter: "left", transferActionEn: "C03 releases the carton only after C01 closes the left hand around its lower edge." }
    });
    f.shot.dialogueTurns = [{ ...f.shot.dialogueTurns[1], sourceDialogueId: "D003", speakerId: "C03", listenerIds: ["C01"], subshotNumber: 1, start: 2, end: 4.8, text: "林岚，你拿稳盒子再看看上面的地址。" }];
    const plan = promptReviewReferencePlan(f.project, f.shot, mode, "image_only");
    saveEvidence(`${mode}-held-product-plan`, { shot: f.shot, plan });
    const identityRoles = plan.hailuoApiMode === "image_to_video" ? plan.frameSourceImageRoles : plan.imageRoles;
    assert.ok(identityRoles.some(role => role.type === "product"), "canonical product image absent from frames and video references");
    const referencedIds = identityRoles.filter(role => role.type === "character").map(role => role.entityId);
    assert.ok(referencedIds.includes("C03") && referencedIds.includes("C01"), `handoff identities disappeared in product detail mode: ${referencedIds}`);
  });

  test(`${mode}: final dialogue is bound to its executable camera timeline line`, () => {
    const f = fixture(mode);
    const prompt = render(f, `${mode}-same-line-dialogue`);
    for (const turn of f.shot.dialogueTurns) {
      const event = spokenEvent(prompt, turn.text);
      assert.match(event.line, /^\[Shot \d+\]/, "spoken contract was detached from the executable camera timeline");
    }
  });
}

test("compiled-spec path applies the same visible identity bijection as ordinary prompt compilation", () => {
  const f = fixture("asset_direct");
  const i = f.references.imageRoles.findIndex(role => role.entityId === "C02");
  f.references.imageRoles.splice(i, 1); f.references.images.splice(i, 1);
  const spec = { specVersion: "test-only", subshots: clone(f.shot.subshots) };
  assert.throws(() => render(f, "compiled-spec-missing-speaker-image", { spec }), error => /CHARACTER.*REFERENCE|REFERENCE.*CHARACTER|STAGING/i.test(String(error.code)), "compiled spec silently bypassed missing visible speaker reference");
});

test("detailed door, footstep and dropped-object sound causality survives final compilation", () => {
  const f = fixture("asset_direct");
  Object.assign(f.shot.subshots[0], {
    actionEn: "C02 turns the brass door handle, opens the wood door, takes two shoe steps onto tile, then drops a metal key onto tile.",
    soundEn: "Continuous quiet room tone. At 0.4 seconds the brass door latch releases with one dry click. At 0.8 seconds the wood door hinge gives one brief creak. At 1.0 and 1.3 seconds C02 makes exactly two rubber-soled footfalls on tile. At 4.8 seconds the falling metal key contacts tile with one sharp clink and settles after a single short rattle."
  });
  f.shot.actionEn = `${f.shot.subshots[0].actionEn} C03 points to the broken seal.`;
  const prompt = render(f, "detailed-sound-events");
  assert.match(prompt, /latch.*(?:click|release)/i, "door latch event was lost");
  assert.match(prompt, /hinge.*creak/i, "door hinge event was lost");
  assert.match(prompt, /(?:footfalls|footsteps).*tile|(?:two|2).*rubber-soled/i, "two physical footsteps and their surface were lost");
  assert.match(prompt, /(?:key.*clink|clink.*key)/i, "dropped metal key contact sound was lost");
  assert.match(prompt, /4\.8/, "dropped-key synchronization time was lost");
});

test("source ledger rejects a line reassigned to a different speaker even when prompt matches the bad turn", () => {
  const f = fixture();
  const prompt = render(f, "source-speaker-mismatch");
  f.project.sourceDialogueLedger = f.shot.dialogueTurns.map(turn => ({ id: turn.sourceDialogueId, speakerId: turn.speakerId, text: turn.text }));
  f.project.sourceDialogueLedger[0].speakerId = "C01";
  const failures = staging.stagingContractFailures(f.project, f.shot, prompt, f.references);
  saveEvidence("source-speaker-mismatch-audit", failures);
  assert.ok(failures.some(item => /SOURCE_DIALOGUE_MISMATCH/.test(item)), "source speaker mismatch escaped audit");
});

test("speaker-facing assertion rejects a real wrong eyeline while permitting a third-person physical target", () => {
  const f = fixture();
  const prompt = render(f, "facing-assertion-negative-control");
  const event = spokenEvent(prompt, f.shot.dialogueTurns[0].text);
  const speaker = subjectFor(prompt, "C02"), target = subjectFor(prompt, "C03"), wrong = subjectFor(prompt, "C01");
  assertSpeakerFacing(event, speaker, target, wrong);
  const corrupted = { ...event, line: event.line.replace(/facing and eyeline are\s+[\s\S]*?(?=\s+Only <Subject \d+>\s*\(S\d+\))/, `facing and eyeline are ${speaker} faces ${wrong}, with eyes and torso toward ${wrong}.`) };
  assert.throws(() => assertSpeakerFacing(corrupted, speaker, target, wrong), /intended addressee|wrong person/);
});

test("staging normalization preserves source words, identities, windows and intentionally different physical target without mutating the source", () => {
  const f = fixture();
  f.shot.dialogueTurns[0].bodyActionEn = "C02 presses a folded towel against C01's injured wrist while speaking to C03.";
  f.shot.dialogueTurns[0].primaryListenerId = "C03";
  f.shot.dialogueTurns[0].speakerFacingEn = "C02 faces C01.";
  f.project.sourceDialogueLedger = f.shot.dialogueTurns.map(turn => ({ id: turn.sourceDialogueId, speakerId: turn.speakerId, primaryListenerId: turn.listenerIds[0], text: turn.text }));
  const before = clone(f);
  const canonical = staging.canonicalizeStagingShot(f.project, f.shot);
  assert.deepEqual(f, before, "normalization changed source project or source turn objects in place");
  assert.deepEqual(canonical.turns.map(turn => [turn.sourceDialogueId, turn.speakerId, turn.text, turn.start, turn.end]), before.shot.dialogueTurns.map(turn => [turn.sourceDialogueId, turn.speakerId, turn.text, turn.start, turn.end]));
  assert.equal(canonical.turns[0].bodyActionEn, before.shot.dialogueTurns[0].bodyActionEn, "physical treatment target was replaced with addressed listener");
  assert.equal(canonical.turns[0].primaryListenerId, "C03");
  assert.match(canonical.turns[0].speakerFacingEn, /C03/);
});

test("actual reordered character images invalidate previously compiled Subject/Picture bindings", () => {
  const f = fixture();
  const prompt = render(f, "reference-order-original");
  [f.references.imageRoles[1], f.references.imageRoles[2]] = [f.references.imageRoles[2], f.references.imageRoles[1]];
  [f.references.images[1], f.references.images[2]] = [f.references.images[2], f.references.images[1]];
  const failures = staging.stagingContractFailures(f.project, f.shot, prompt, f.references);
  saveEvidence("reference-order-audit", failures);
  assert.ok(failures.some(item => /REFERENCE_IDENTITY_MISMATCH/.test(item)), "actual image-role reorder escaped prompt audit");
});

test("one physical image cannot stand in for two different principal identities", () => {
  const f = fixture();
  f.references.images[1] = f.references.images[2];
  let prompt;
  try { prompt = render(f, "duplicate-physical-character-image"); }
  catch (error) { assert.match(`${error.code} ${error.message}`, /REFERENCE|IDENTITY|duplicate|character|身份|重复/i); return; }
  const failures = staging.stagingContractFailures(f.project, f.shot, prompt, f.references);
  saveEvidence("duplicate-physical-character-image-audit", failures);
  assert.ok(failures.some(item => /duplicate|shared|image|identity|reference/i.test(item)), "same physical image accepted for C01 and C03");
});

test("cross-shot cast audit rejects repeated entrance and unexplained screen-side jump", () => {
  const project = { shots: [
    { id: "S01", sceneId: "SC01", castState: [{ characterId: "C01", presentBefore: false, entryActionEn: "C01 enters through the rear door.", presentAfter: true, screenSide: "screen-left", appearanceStateId: "W01" }] },
    { id: "S02", sceneId: "SC01", castState: [{ characterId: "C01", presentBefore: false, entryActionEn: "C01 enters through the rear door again.", presentAfter: true, screenSide: "screen-right", appearanceStateId: "W01" }] }
  ] };
  const failures = staging.crossShotStagingFailures(project);
  saveEvidence("cross-shot-entry-and-side", { project, failures });
  assert.ok(failures.some(item => /REPEATED_ENTRANCE/.test(item)));
  assert.ok(failures.some(item => /SCREEN_SIDE_TELEPORT/.test(item)));
});

test("cross-shot appearance cannot disappear by omitting next-shot state after a visible costume change", () => {
  const project = { shots: [
    { id: "S01", sceneId: "SC01", castState: [{ characterId: "C01", presentBefore: true, presentAfter: true, screenSide: "screen-left", appearanceStateId: "W01" }] },
    { id: "S02", sceneId: "SC01", castState: [{ characterId: "C01", presentBefore: true, presentAfter: true, screenSide: "screen-left" }] }
  ] };
  const failures = staging.crossShotStagingFailures(project);
  saveEvidence("cross-shot-omitted-appearance", { project, failures });
  assert.ok(failures.some(item => /appearance|wardrobe/i.test(item)), "omitted appearance silently reset the continuity ledger");
});

test("strict sound audit detects missing footstep and impact events even when one door event exists", () => {
  const f = fixture();
  const basePrompt = render(f, "partial-sound-event-ledger");
  f.shot.stagingContractVersion = staging.STAGING_CONTRACT_VERSION;
  f.shot.actionBeats = [{ id: "B1", start: 0, end: 12, actorCharacterId: "C02", actionEn: "C02 opens the door, walks into the room, then drops the metal key onto the floor.", soundEvents: [{ id: "FX1", actionBeatId: "B1", start: 0.4, end: 1.1, sourceObjectId: "door", eventType: "door", triggerEn: "The hinge moves with the door.", descriptionEn: "One wood-door hinge creak follows the opening." }] }];
  const prompt = `${basePrompt}\n${staging.sourceSoundTimeline(f.shot)}`;
  const failures = staging.stagingContractFailures(f.project, f.shot, prompt, f.references, { strict: true });
  saveEvidence("partial-sound-event-audit", { events: staging.physicalSoundEvents(f.shot), failures });
  assert.ok(failures.some(item => /foot|impact|missing.*event|uncovered|coverage|SFX_NEEDS/i.test(item)), "one explicit door event concealed two missing physical source sounds");
});

test("strict actor-held product transfer requires an identified final holder and hand", () => {
  const f = fixture();
  const basePrompt = render(f, "incomplete-product-handoff");
  f.shot.stagingContractVersion = staging.STAGING_CONTRACT_VERSION;
  f.shot.productPresentation = { productAssetId: "asset_product", holderCharacterId: "C03", holderHand: "right", transferActionEn: "C03 passes the product to C01." };
  f.shot.actionBeats = [{ id: "B1", start: 0, end: 12, actionEn: "C03 passes the product to C01.", soundEvents: [{ id: "FX1", start: 5, end: 6, eventType: "product_handling", sourceCharacterId: "C03", sourceObjectId: "asset_product", triggerEn: "Receiving fingers make contact.", descriptionEn: "Soft carton friction follows the supported handoff." }] }];
  const prompt = `${basePrompt}\n${staging.sourceSoundTimeline(f.shot)}`;
  const failures = staging.stagingContractFailures(f.project, f.shot, prompt, f.references, { strict: true });
  saveEvidence("incomplete-product-handoff-audit", failures);
  assert.ok(failures.some(item => /holder|handoff|transfer|product/i.test(item)), "handoff accepted without a final holder/hand continuity state");
});

test("production package skill executes the byte-identical staging and timing helpers", () => {
  const skillScripts = "D:/CodexData/.codex/skills/puream-drama-production-package/scripts";
  for (const name of ["drama-staging-contract.js", "drama-performance-timeline.js", "drama-timing.js", "source-performance-budget.js", "staged-upload-preparation.js", "native-identity-cues.js", "storyboard-still-author.js", "h3-final-prompt-editor.js"]) {
    const local = fs.readFileSync(path.resolve(__dirname, "../app", name));
    const skillPath = path.join(skillScripts, name);
    assert.ok(fs.existsSync(skillPath), `skill runtime missing ${name}`);
    assert.equal(fs.readFileSync(skillPath).compare(local), 0, `app and skill differ for ${name}`);
  }
  const skillStaging = require(path.join(skillScripts, "drama-staging-contract.js"));
  const f = fixture("production_package");
  const prompt = render(f, "skill-app-runtime-parity");
  f.project.sourceDialogueLedger = [{ id: "D001", speakerId: "C01", text: f.shot.dialogueTurns[0].text }];
  assert.deepEqual(skillStaging.stagingContractFailures(f.project, f.shot, prompt, f.references), staging.stagingContractFailures(f.project, f.shot, prompt, f.references));
  assert.ok(skillStaging.stagingContractFailures(f.project, f.shot, prompt, f.references).some(item => /SOURCE_DIALOGUE_MISMATCH/.test(item)));
});

test.after(() => saveEvidence("run-observations", { createdAt: new Date().toISOString(), observations }));

module.exports = { fixture, subjectFor, spokenEvent, MODES };
