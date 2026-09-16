const test=require('node:test'),assert=require('node:assert/strict');
const {compileProductionContract,contractPromptBlock}=require('../app/foundry/production-contract');
const {storyAssetDirective}=require('../app/workbench-workflow');
test('static asset contracts cannot leak character sheets or dialogue rules across stages',()=>{
 const contract=compileProductionContract({id:'stage-test',productionPlan:{inputMode:'manual',scriptHandling:'respect',commerceMode:'none'},generation:{mode:'asset_direct'}},{});
 assert.doesNotMatch(contractPromptBlock(contract,'scene_asset'),/四个等比例全身|只允许：剧中角色对白/);
 assert.doesNotMatch(contractPromptBlock(contract,'character_intro'),/四个等比例全身|正面全身、左侧全身/);
 assert.match(contractPromptBlock(contract,'character_intro'),/单视角身份照片/);
 assert.match(contractPromptBlock(contract,'character_sheet'),/多视图身份参考板/);
 assert.doesNotMatch(contractPromptBlock(contract),/人物四视图/);
});
test('character identity context cannot drag another actor or a plot prop into the portrait',()=>{
 const project={characters:[{id:'C01',name:'甲'},{id:'C02',name:'乙'}],shots:[{characterIds:['C01','C02'],action:'乙摔倒，甲拿商品罐扶住乙',mainlineBeat:'乙摔倒',dialogue:'甲：小心。'}]};
 const prompt=storyAssetDirective(project,'character_intro',{id:'C01',name:'甲',role:'快递员',ageBand:'青年',gender:'male'});
 assert.match(prompt,/青年/);assert.doesNotMatch(prompt,/乙|摔倒|扶住/);
});
