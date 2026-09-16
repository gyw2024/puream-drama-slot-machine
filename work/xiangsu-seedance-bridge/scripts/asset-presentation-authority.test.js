'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewBatchSource,promptReviewRules}=require('../app/agent-stage-tasks');
const authority=require('../app/asset-presentation-authority');
test('asset evidence preserves original identity separately from a conflicting generated layout',()=>{
 const canonical={id:'C1',name:'Gu',description:'65-year-old man in a grey jacket.'};
 const design={version:'v',sourceAuthority:'analysis-context',sourceDescription:canonical.description,designChoices:[]};
 const source={acceptedShotScreenplay:true,characters:[{...canonical,description:'Full-body front reference, 16:9.',visualDesign:design}],scenes:[],props:[],shots:[],canonicalAssetSource:{characters:[canonical],scenes:[],props:[],shots:[]}};
 const input=structuredClone(source),batch=[{id:'character:C1:character_intro',entityType:'character',entityId:'C1',stage:'character_intro'}];
 const packet=reviewBatchSource(source,batch);
 assert.equal(packet.canonicalAssetEvidence.characters[0].description,canonical.description);
 assert.equal(packet.characters[0].visualDesign.sourceDescription,canonical.description);
 assert.equal(packet.characters[0].visualDesign.sourceAuthority,'analysis-context');
 assert.match(packet.characters[0].description,/16:9/,'retain the actual derived proposal for independent review');
 assert.deepEqual(Object.keys(packet.assetPresentationRequirements.stages),['character_intro']);
 assert.match(packet.assetPresentationRequirements.stages.character_intro,/vertical/);
 assert.ok(promptReviewRules(batch).includes(authority.INSTRUCTION));
 assert.deepEqual(source,input);
});
test('presentation is stage-specific and is not imposed on a video review',()=>{
 const stages=['character_intro','character_sheet','character_three_view','scene_asset','prop_asset','wardrobe_asset'];
 for(const stage of stages)assert.deepEqual(Object.keys(authority.packet([stage]).stages),[stage]);
 const batch=[{id:'shot:S1:shot_video',entityType:'shot',entityId:'S1',stage:'shot_video',group:'videos'}];
 assert.equal(reviewBatchSource({characters:[],scenes:[],props:[],shots:[]},batch).assetPresentationRequirements,undefined);
 assert.equal(promptReviewRules(batch).includes(authority.INSTRUCTION),false);
});
