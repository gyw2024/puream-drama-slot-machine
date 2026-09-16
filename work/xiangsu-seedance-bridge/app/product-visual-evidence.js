"use strict";
const fs=require('node:fs'),crypto=require('node:crypto');
const responseSchema={type:'object',additionalProperties:false,required:['packagingDescriptionZh','packagingDescriptionEn','containerType','visibleParts','notVisible','uncertainties'],properties:{...Object.fromEntries(['packagingDescriptionZh','packagingDescriptionEn','containerType'].map(key=>[key,{type:'string',minLength:1}])),...Object.fromEntries(['visibleParts','notVisible','uncertainties'].map(key=>[key,{type:'array',items:{type:'string'}}]))}};
function supported(provider){
 const agent=provider?.localAgent;
 return ['codex','grokbuild'].includes(agent?.id)||(agent?.id==='workbuddy'&&agent.authoringMode==='mcp'&&require('./workbuddy-model-cache').readBuiltin(agent.model)?.model?.supportsImages===true);
}
async function observeProduct(product,generate){
 const file=product?.imagePath;if(!file||!fs.existsSync(file))return null;
 if(fs.statSync(file).size>30*1024*1024)throw new Error('Product image is too large for evidence review');
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(product.visualEvidence?.sha256===sha256&&product.visualEvidence?.status==='observed')return product.visualEvidence;
 const result=await generate([{role:'system',content:require('./generation-prompts').build('product','Read only the supplied product image. Do not generate or edit any image. Describe directly visible packaging, not health efficacy, price, ingredients, dose or instructions. Never assume an outer box exists when the image shows a jar/tube/pouch only. Do not infer glass versus plastic solely from transparency; describe appearance and mark uncertain material. Return JSON {packagingDescriptionZh,packagingDescriptionEn,containerType,visibleParts:[...],notVisible:[...],uncertainties:[...]}. Unreadable print stays unreadable; no invented labels. Keep descriptions concise and physical.')},{role:'user',content:`User product name: ${product.name}. Inspect the attached original photograph and record the packaging that actors must physically hold unchanged.`}],{json:true,requiredKeys:responseSchema.required,responseSchema,visionImages:[{path:file,purpose:'immutable user product packaging'}],agentStage:'planning',costOperation:'product_visual_evidence',maxTokens:3000});
 if(!result.packagingDescriptionZh||!result.packagingDescriptionEn||!result.containerType||!Array.isArray(result.visibleParts)||!Array.isArray(result.notVisible)||!Array.isArray(result.uncertainties))throw new Error('Product observation is incomplete');
 return {...result,status:'observed',sha256,sourcePath:file,observedAt:new Date().toISOString(),kind:'visual-observation-not-user-marketing-claim'};
}
module.exports={observeProduct,supported};
