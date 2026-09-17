'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const language=require('../app/asset-description-language'),author=require('../app/asset-design-author');
test('unchanged product-image inscriptions pass first delivery while invented Chinese remains rejected',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'product-evidence-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const imagePath=path.join(dir,'original.png');fs.writeFileSync(imagePath,'test-image-v1');
 const evidence={status:'observed',sha256:crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'),packagingDescriptionEn:'A black jar. Printed text reads “黄精” and “净含量：300克”.',visibleParts:[]};
 const p={script:{raw:'女儿持未开封商品。'},product:{name:'原商品',imagePath,visualEvidence:evidence},characters:[],scenes:[],props:[{id:'P1',name:'未开封商品',description:''}]};let calls=0;
 await author.authorMissingDesigns({project:p,characters:[],save:()=>{},generate:async messages=>{
  calls++;const input=JSON.parse(messages[1].content);assert.equal(input.productVisualEvidence.sha256,evidence.sha256);
  assert.ok(input.lockedSourceInscriptions.includes('净含量：300克'));
  return {items:[{id:'prop:P1',descriptionZh:'黑色罐，原有文字“黄精”“净含量：300克”，包装不改变。',descriptionEn:'An unopened original black jar retains its original lid and printed label. The literal packaging reads “黄精” and “净含量：300克”, without invented details.',designChoices:[]}]};
 }});
 assert.equal(calls,1);assert.equal(author.pendingDesigns(p,[]).length,0);
 assert.equal(language.hasChineseNarrative('Invented 立即见效',language.observedProductLiterals(p.product)),true);
 assert.equal(language.hasChineseNarrative('The label reads 黄精系列 and 黄精.', ['黄精','黄精系列']),false);
 assert.equal(language.normalizeEntityNames('黄精系列',[],['黄精','黄精系列']).text,'黄精系列');
 fs.writeFileSync(imagePath,'different-image');assert.equal(language.observedProductEvidence(p.product),null);assert.deepEqual(language.observedProductLiterals(p.product),[]);
});
test('provider-wide quota stops undispatched audits and preserves successful in-flight receipts',async()=>{
 const tasks=require('../app/agent-stage-tasks');
 const items=Array.from({length:20},(_,i)=>({id:'I'+i,prompt:'A neutral approved asset.',entityType:'prop',stage:'prop_asset'}));
 const settings={localAgents:{stages:{review:'codex'},providers:{codex:{model:'test'}}},textProvider:{}};
 let calls=0,checkpoint;
 await assert.rejects(tasks.reviewStagePrompts(items,settings,async(_c,m)=>{
  const n=++calls,rows=JSON.parse(m[1].content).items;
  if(n===1)throw Object.assign(Error('quota exhausted'),{code:'LOCAL_AGENT_QUOTA_EXHAUSTED'});
  await new Promise(resolve=>setTimeout(resolve,20));return {items:rows.map(r=>({id:r.id,issues:[]}))};
 },{parallelBatches:2,saveCheckpoint:value=>{checkpoint=value;}}),{code:'LOCAL_AGENT_QUOTA_EXHAUSTED'});
 assert.equal(calls,2);assert.equal(checkpoint.batches.filter(b=>b.status==='reviewed').length,1);
 assert.equal(checkpoint.batches.filter(b=>b.status==='needs_attention').length,1);
 assert.equal(items.filter(i=>i.agentAudit&&i.agentAudit.status==='reviewed').length,5);
});
