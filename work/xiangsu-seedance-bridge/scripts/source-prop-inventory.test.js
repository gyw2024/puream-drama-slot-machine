'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),api=require('../app/source-prop-inventory');
test('cached expanded incidental objects use the same evidence filter as compact objects',()=>{
 const p=fixture(),r=result();r.assets[1].classification='incidental';r.assets[1].sourceQuotes=['笔记里滑出'];r.assets[1].appearances.push({shotId:'S02',visibility:'visible',evidence:''});p.shots.push({id:'S02',action:'两人对坐'});
 api.expandCompact(r,p);assert.equal(r.assets[1].classification,'in_scene');assert.equal(r.assets[1].appearances.length,1);assert.deepEqual(api.validate(r,p,api.declarations(p)),[]);
 const core=result();core.assets[0].appearances[0]={shotId:'S02',visibility:'visible',evidence:'不存在的物件'};api.expandCompact(core,p);assert.match(api.validate(core,p,api.declarations(p)).join(' '),/grounded/);
});
test('changed evidence receives the complete source catalog and cannot reuse an old fingerprint',async()=>{
 const p=fixture(),r=result();r.assets[1].sourceQuotes=['笔记里滑出'];r.assets[0].sourceQuotes=['不存在的原文'];p.sourcePropInventoryCheckpoint={fingerprint:api.fingerprint(p),lastResult:r};
 p.shots[0].stateBefore='两张老照片保持折叠';let request;
 const good=result();good.assets[1].sourceQuotes=['笔记里滑出'];
 await api.reconcile({project:p,generate:async messages=>{request=JSON.parse(messages[1].content);return good;},save:()=>{}});
 for(const line of p.script.formatAdaptation.productionScript.split('\n'))assert.ok(request.evidence.some(e=>e.text===line));assert.equal(request.repair.length,0);assert.ok(request.evidence.some(e=>e.text.includes('保持折叠')&&e.shotIds.includes('S01')));
});
function fixture(){return {script:{raw:'两张老照片从笔记里滑出。',formatAdaptation:{productionScript:'### S01｜场景：屋内\n【核心物品】两张老照片；笔记本。\n【动作】两张老照片从笔记里滑出。'}},shots:[{id:'S01',action:'两张老照片从笔记里滑出。'}],assetLibraries:{props:[]},candidates:[]};}
test('inventory policy changes invalidate old extraction receipts even for unchanged prose',t=>{
 const contract=require('../app/inventory-evidence-contract'),previous=contract.INSTRUCTION,p=fixture(),before=api.fingerprint(p);
 t.after(()=>{contract.INSTRUCTION=previous;});contract.INSTRUCTION+=' Require source-implied vessels.';
 assert.notEqual(api.fingerprint(p),before);
});
function result(){return {assets:[{key:'photo',name:'两张老照片',classification:'core',sourceQuotes:['两张老照片'],appearances:[{shotId:'S01',visibility:'visible',evidence:'两张老照片从笔记里滑出'}],reason:'身份辨认'}, {key:'book',name:'笔记本',classification:'in_scene',sourceQuotes:['笔记'],appearances:[{shotId:'S01',visibility:'visible',evidence:'笔记里滑出'}],reason:'单次出现且不承担辨认'}],decisions:[{id:'G001',classification:'mapped',assetKeys:['photo'],reason:'两张纸片原文有据'},{id:'G002',classification:'mapped',assetKeys:['book'],reason:'保留镜内物件'}]};}
test('background props remain background; unsupported optional occurrences cannot become references',()=>{
 const p=fixture(),r=result();p.shots.push({id:'S02',action:'两人对坐'});
 const a=r.assets[1];a.sourceQuotes=['笔记里滑出'];delete a.appearances;a.aliases=['笔记'];a.visibleShotIds=['S01','S02'];
 api.expandCompact(r,p);assert.deepEqual(api.validate(r,p,api.declarations(p)),[]);
 assert.equal(r.discardedUnverifiedAppearances[0].shotId,'S02');api.apply(r,p,api.declarations(p));
 assert.equal(p.assetLibraries.props.find(x=>x.name==='笔记本').coreStory,false);
 assert.deepEqual(p.shots[1].propIds,[]);
});
test('a single-character cup alias needs an explicit physical handling verb',()=>{
 const p={shots:[{id:'S01',action:'老人捧杯坐下'},{id:'S02',action:'谈起世界杯'}]},r={assets:[{name:'热水杯',aliases:['杯'],classification:'core',visibleShotIds:['S01','S02']}]};
 api.expandCompact(r,p);assert.equal(r.assets[0].appearances[0].evidence,'捧杯');assert.equal(r.assets[0].appearances[1].evidence,'');
});
test('saved complete inventory is revalidated without a second model call',async()=>{
 const p=fixture(),r=result();r.assets[1].sourceQuotes=['笔记里滑出'];p.sourcePropInventoryCheckpoint={fingerprint:api.fingerprint(p),lastResult:r};let calls=0,saves=0;
 await api.reconcile({project:p,generate:async()=>{calls++;throw Error('unnecessary generation');},save:()=>saves++});
 assert.equal(calls,0);assert.equal(saves,1);assert.equal(p.sourcePropInventory.status,'completed');
});
test('missing declared props trigger reconciliation; all decisions and shot evidence are checked',()=>{
 const p=fixture(),r=result();r.assets[1].sourceQuotes=['笔记里滑出'];assert.equal(api.pending(p),true);assert.deepEqual(api.validate(r,p,api.declarations(p)),[]);
 r.assets[0].appearances[0].evidence='想象的照片';assert.match(api.validate(r,p,api.declarations(p)).join(' '),/grounded/);
 r.decisions.pop();assert.match(api.validate(r,p,api.declarations(p)).join(' '),/exactly one/);
});
test('stored props are not visible bindings and real prior assets are preserved',()=>{
 const p=fixture(),r=result();r.assets[0].appearances.push({shotId:'S02',visibility:'stored',evidence:'照片仍收在口袋'});p.shots.push({id:'S02',action:'照片仍收在口袋'});
 p.assetLibraries.props=[{id:'Pold',name:'旧证物',coreStory:true,units:[]}];p.candidates=[{entityId:'Pold',stage:'prop_asset',filePath:'real.png'}];
 api.apply(r,p,api.declarations(p));assert.equal(p.assetLibraries.props.length,3);assert.equal(p.shots[0].propIds.length,1);assert.deepEqual(p.shots[1].propIds,[]);assert.equal(api.pending(p),false);assert.equal(p.candidates[0].filePath,'real.png');
});
test('already covered simple declarations and scripts without declarations add no Agent calls',()=>{
 const p=fixture();p.assetLibraries.props=[{name:'两张老照片'},{name:'笔记本'}];assert.equal(api.pending(p),false);assert.equal(api.pending({}),false);
});
test('compact occurrences expand only from exact shot evidence; unsupported IDs still fail',()=>{
 const p=fixture(),r=result();for(const a of r.assets){a.aliases=['笔记里滑出'];a.sourceQuotes=['笔记里滑出'];a.visibleShotIds=['S01'];delete a.appearances;}
 api.expandCompact(r,p);assert.deepEqual(api.validate(r,p,api.declarations(p)),[]);
 r.assets[0].appearances.push({shotId:'S99',visibility:'visible',evidence:'照片'});assert.match(api.validate(r,p,api.declarations(p)).join(' '),/grounded/);
});
test('a completed source fingerprint cannot hide a removed or replaced physical identity',()=>{
 const p=fixture(),r=result();api.apply(r,p,api.declarations(p));assert.equal(api.pending(p),false);
 const original=structuredClone(p.assetLibraries.props);p.assetLibraries.props.pop();assert.equal(api.pending(p),true);
 p.assetLibraries.props=original;p.assetLibraries.props[0].name='另一张照片';assert.equal(api.pending(p),true);
});
test('inventory replay preserves same identity design but cannot copy a corrupted ID appearance',()=>{
 const p=fixture(),r=result();api.apply(r,p,api.declarations(p));p.assetLibraries.props[0].descriptionEn='Reviewed group photo design';
 api.apply(r,p,api.declarations(p));assert.equal(p.assetLibraries.props[0].descriptionEn,'Reviewed group photo design');
 p.assetLibraries.props[0].name='另一张照片';api.apply(r,p,api.declarations(p));assert.equal(p.assetLibraries.props[0].descriptionEn,undefined);
});
test('locked product and ungrounded background objects are excluded with a retained disposition',()=>{
 const p=fixture();p.product={name:'测试商品'};p.script.raw+='测试商品在桌边。墙上挂钟响起。';
 const r=result();r.assets[1].sourceQuotes=['笔记里滑出'];r.assets.push({key:'product',name:'测试商品',classification:'core',sourceQuotes:['测试商品在桌边'],visibleShotIds:['S01']},{key:'clock',name:'挂钟',classification:'in_scene',sourceQuotes:['墙上挂钟响起'],visibleShotIds:['S01']});
 api.expandCompact(r,p);assert.equal(r.assets.length,2);assert.equal(r.excludedAssets.length,2);assert.deepEqual(api.validate(r,p,api.declarations(p)),[]);
});
test('a unique exact source suffix repairs evidence without merging distinct photograph identities',()=>{
 const p={shots:[{id:'S01',action:'夹克仍在后座，两张照片放在桌上'}]},r={assets:[{key:'j',name:'旧军绿色夹克',classification:'core',visibleShotIds:['S01']},{key:'a',name:'毕业照片',classification:'core',visibleShotIds:['S01']},{key:'b',name:'家庭照片',classification:'core',visibleShotIds:['S01']}],decisions:[]};api.expandCompact(r,p);assert.equal(r.assets[0].appearances[0].evidence,'夹克');assert.equal(r.assets[1].appearances[0].evidence,'');assert.equal(r.assets[2].appearances[0].evidence,'');
});
test('a product name inside a vessel identity cannot consume that separate prop or skip a mixed declaration',()=>{
 const p={product:{name:'菊花茶'},script:{raw:'菊花茶杯放在桌面。',formatAdaptation:{productionScript:'【核心物品】菊花茶、菊花茶杯'}},shots:[{id:'S01',action:'菊花茶杯放在桌面'}],assetLibraries:{props:[{id:'tea',name:'菊花茶'}]}};
 assert.equal(api.pending(p),true);
 const result={assets:[{key:'cup',name:'菊花茶杯',classification:'core',sourceQuotes:['菊花茶杯放在桌面'],visibleShotIds:['S01']}],decisions:[]};
 api.expandCompact(result,p);assert.equal(result.assets.length,1);
 assert.ok(!api.validate(result,p,api.declarations(p)).some(e=>e.includes('locked product')));
});
