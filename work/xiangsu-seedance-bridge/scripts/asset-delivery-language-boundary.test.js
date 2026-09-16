const test=require('node:test'),assert=require('node:assert/strict');
const {validateDesignDelivery}=require('../app/asset-design-author');
test('unquoted source engraving and asset name reach Agent review without endless delivery rejection',async()=>{
 const row={id:'prop:P03',descriptionEn:'搪瓷粥碗组: six white enamel bowls with blue rims, one bowl has the source-required hand engraving 满 on its underside. Preserve that engraving and show the empty bowls.',descriptionZh:'六只搪瓷碗，其中一只碗底浅刻满字。',designChoices:[]};
 const context={project:{script:{raw:'其中一只碗底浅刻一个满字。'},characters:[]},literalTerms:[],requiredPrintedLiterals:[]};
 assert.equal(validateDesignDelivery(row,context),true);assert.match(row.languageReviewNote,/Agent audit/);
 const receipt=await require('../app/agent-item-contract').complete({items:[{id:row.id}],cached:{items:[],rawLastResponse:{items:[row]}},valid:r=>validateDesignDelivery(r,context),generate:()=>assert.fail('complete cached source engraving must not be regenerated')});
 assert.equal(receipt.missingIds.length,0);
 const prompt=require('../app/physical-asset-prompt').physicalAssetPrompt('prop_asset',{descriptionEn:row.descriptionEn,visualDesign:{descriptionEn:row.descriptionEn}});
 assert.ok(prompt);assert.match(prompt,/engraving 满/);
});
test('delivery repair gets exact field feedback rather than an unexplained rejection',()=>{
 const context={project:{},literalTerms:[],requiredPrintedLiterals:[]};
 assert.throws(()=>validateDesignDelivery({descriptionEn:'',descriptionZh:'',designChoices:null},context),e=>e.issues.length===3&&e.message.includes('descriptionEn:')&&e.message.includes('descriptionZh:')&&e.message.includes('designChoices:'));
});
