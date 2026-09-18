'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const screenplay=require('../app/shot-screenplay'),authority=require('../app/product-claim-authority');
const fixture=require('./shot-screenplay-fixture').fixture;
for(const mode of ['original','upload','adapt'])test(mode+': independent user product facts survive a conflicting reviewer proposal across author/review/repair',async()=>{
 const product={name:'测试牙膏',description:'120g',sellingPoints:'日常清洁；清新口气；不是药。',price:'模拟9.9元',offer:'模拟2支',purchaseInstructions:'模拟橱窗',testDataNote:'仅测试'};
 const d=fixture();if(mode==='adapt')d.adaptation={title:'测试',kernel:'相聚',ending:'相伴',replacements:[],productName:product.name,productLocks:[],warnings:[],beats:[]};
 const calls=[];let reviews=0;const badAdvice='把对白替换为它能清热益气。';
 const result=await screenplay.author({mode,source:mode==='original'?'':'旧稿里声称清热益气，尚待核对。',product,deferReview:false,generate:async(m,o)=>{
  const input=JSON.parse(m[1].content);calls.push(o.stage);
  assert.deepEqual(input.productClaimAuthority,authority.packet(product));
  assert.ok(m[0].content.includes(authority.INSTRUCTION));
  if(o.stage==='shot_screenplay_draft')return '完整中文剧本首稿';
  if(o.stage==='shot_screenplay_structure'||o.stage==='shot_screenplay_write')return structuredClone(d);
  if(o.stage==='shot_screenplay_review'){reviews++;return {ok:reviews>1,storyComplete:true,sourcePreserved:true,checks:Object.fromEntries(d.shots.map(s=>[s.id,{evidence:'fixture protocol evidence'}])),issues:reviews===1?[{shotIds:[d.shots[0].id],field:'dialogue',evidence:'unsupported claim',repair:badAdvice}]:[]};}
  if(o.stage==='shot_screenplay_review_findings')return require('./source-finding-test-helper')(m);
  assert.equal(input.findings[0].repair,badAdvice);
  assert.equal(o.progressiveDelivery,true);
  assert.equal(input.productClaimAuthority.facts.sellingPoints,product.sellingPoints);
  return {shots:[structuredClone(d.shots[0])],additions:[]};
 }});
 assert.equal(result.status,'ready');assert.deepEqual(calls,['shot_screenplay_draft','shot_screenplay_structure','shot_screenplay_review','shot_screenplay_review_findings','shot_screenplay_repair','shot_screenplay_review']);
});
