'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assetBearingScenes,sceneReferenceRequired}=require('../app/asset-eligibility');
const {WorkbenchWorkflow,promptReviewReferencePlan}=require('../app/workbench-workflow');
function fixture(mode='asset_direct'){
 const project={id:'test',generation:{mode,engine:'hailuo-h3',aspectRatio:'9:16'},product:{},script:{raw:''},characters:[],scenes:[{id:'declined',name:'Source-only location',assetRequired:false},{id:'needed',name:'Required set',assetRequired:true},{id:'legacy',name:'Legacy set'}],assetLibraries:{props:[],wardrobes:[]},candidates:[],shots:[]};
 const workflow=Object.create(WorkbenchWorkflow.prototype);workflow.store={getProject:()=>project,getSettings:()=>({generation:{qualityGatesEnabled:false},videoProvider:{hailuoReferenceAudioMode:'image_only'}})};return{project,workflow};
}
for(const mode of ['asset_direct','keyframe','storyboard_sheet'])test(mode+' uses the same Agent scene decision for plans and both reference manifests',()=>{
 const {project,workflow}=fixture(mode),shot={id:'S01',sceneId:'declined',duration:10,characterIds:[],visibleCharacterIds:[],dialogueTurns:[]};project.shots=[shot];const before=JSON.stringify(project.scenes);
 assert.deepEqual(assetBearingScenes(project).map(s=>s.id),['needed','legacy']);
 assert.deepEqual(workflow.buildAssetBatchPlan('test').filter(i=>i.kind==='scene_asset').map(i=>i.entityId),['needed','legacy']);
 assert.equal(promptReviewReferencePlan(project,shot,mode).imageRoles.some(r=>r.type==='scene'),false);
 assert.equal(workflow.shotReferences(project,shot,mode).imageRoles.some(r=>r.type==='scene'),false);
 assert.equal(JSON.stringify(project.scenes),before,'story locations and Agent flags remain untouched');
 for(const id of ['needed','legacy']){shot.sceneId=id;assert.equal(sceneReferenceRequired(project,shot),true);const plan=promptReviewReferencePlan(project,shot,mode);const roles=mode==='keyframe'?plan.frameSourceImageRoles:plan.imageRoles;assert.equal(roles.some(r=>r.type==='scene'&&r.entityId===id),true);assert.throws(()=>workflow.shotReferences(project,shot,mode),e=>e.code==='SHOT_SCENE_REFERENCE_REQUIRED');}
});
test('explicit per-shot scene-image opt-out is preserved by preview and submission without deleting the scene asset',()=>{
 const {project,workflow}=fixture(),shot={id:'S02',sceneId:'needed',duration:10,videoReferenceIncludeScene:false,characterIds:[],visibleCharacterIds:[],dialogueTurns:[]};project.shots=[shot];
 assert.equal(promptReviewReferencePlan(project,shot,'asset_direct').imageRoles.some(r=>r.type==='scene'),false);assert.equal(workflow.shotReferences(project,shot,'asset_direct').imageRoles.some(r=>r.type==='scene'),false);assert.ok(workflow.buildAssetBatchPlan('test').some(i=>i.entityId==='needed'));
});
