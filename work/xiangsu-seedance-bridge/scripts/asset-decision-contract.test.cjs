'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../app/asset-decision-contract');
const c = { id: 'C1' };
const closed = { scopeVerified: true, requireExternalVoiceReference: false };
const visual = { anyVisible: true, cameraOwned: true, hasTaskUse: true };
const offscreen = { visualCoverageComplete: true, vocalCoverageComplete: true,
  sourceRelationsComplete: true, offscreenOnly: true, hasVocalEvent: true,
  anyVisible: false, hasTaskUse: true, hasPendingUse: false };
const unused = { visualCoverageComplete: true, vocalCoverageComplete: true,
  sourceRelationsComplete: true, hasVocalEvent: false, anyVisible: false,
  hasTaskUse: false, hasPendingUse: false };
const cases = [
 ['单镜主体需要身份', () => assert.equal(r.decideCharacter(c, visual).visualRequirement, 'required')],
 ['非主体镜内说话者需要身份', () => assert.equal(r.decideCharacter(c, {visibleSpeaker:true}).visualRequirement, 'required')],
 ['可见指定听者需要身份', () => assert.equal(r.decideCharacter(c, {visibleNamedListener:true}).visualRequirement, 'required')],
 ['仅可见不是充分身份证据', () => assert.equal(r.decideCharacter(c, {anyVisible:true}).visualRequirement, 'unknown')],
 ['仅background标签不足以排除', () => assert.equal(r.decideCharacter({...c,castingTier:'background'}).visualRequirement, 'unknown')],
 ['仅offscreen标签不足以排除', () => assert.equal(r.decideCharacter({...c,castingTier:'offscreen'}).visualRequirement, 'unknown')],
 ['仅lead标签也不凭空造视觉证据', () => assert.equal(r.decideCharacter({...c,castingTier:'lead'}).visualRequirement, 'unknown')],
 ['层级与主体冲突只警告不删身份', () => { const d=r.decideCharacter({...c,castingTier:'background'},visual);assert.equal(d.visualRequirement,'required');assert.equal(d.tierConflict,true); }],
 ['明确用户排除与主体冲突待决策', () => assert.equal(r.decideCharacter(c, visual, {trustedVisualChoice:'exclude'}).visualRequirement, 'needs_decision')],
 ['全范围仅画外不需要视觉', () => assert.equal(r.decideCharacter(c, offscreen, closed).visualRequirement, 'not_required')],
 ['画外发言仍需要声音身份', () => assert.equal(r.decideCharacter(c, offscreen, closed).voiceIdentityRequirement, 'required')],
 ['声音身份与外部音频分开', () => assert.equal(r.decideCharacter(c, offscreen, closed).voiceReferenceRequirement, 'optional')],
 ['音频能力未知不伪装可选', () => assert.equal(r.decideCharacter(c,offscreen,{scopeVerified:true}).voiceReferenceRequirement,'unknown')],
 ['实际协议要求外部音频', () => assert.equal(r.decideCharacter(c,offscreen,{...closed,requireExternalVoiceReference:true}).voiceReferenceRequirement,'required')],
 ['未验证范围不能证明画外only', () => assert.equal(r.decideCharacter(c,offscreen,{}).visualRequirement,'unknown')],
 ['全任务无任何用途可判本轮非必需', () => assert.equal(r.decideCharacter(c,unused,closed).visualRequirement,'not_required')],
 ['原稿用途未覆盖则保持未知', () => assert.equal(r.decideCharacter(c,{...unused,sourceRelationsComplete:false},closed).visualRequirement,'unknown')],
 ['存在待分配用途不能判未使用', () => assert.equal(r.decideCharacter(c,{...unused,hasPendingUse:true},closed).visualRequirement,'unknown')],
 ['完整静默证据不创建声音身份', () => assert.equal(r.decideCharacter(c,unused,closed).voiceIdentityRequirement,'not_required')],
 ['视觉证据完整不等于声音证据完整', () => assert.equal(r.decideCharacter(c,{...unused,vocalCoverageComplete:false},closed).voiceIdentityRequirement,'unknown')],
 ['only画外与可见责任矛盾待决策', () => assert.equal(r.decideCharacter(c,{...offscreen,...visual},closed).visualRequirement,'needs_decision')],
 ['匿名背景证据与实名责任矛盾待决策', () => assert.equal(r.decideCharacter(c,{...visual,visualCoverageComplete:true,anonymousBackgroundOnly:true},closed).visualRequirement,'needs_decision')],
 ['已验证匿名背景无自动视觉', () => assert.equal(r.decideCharacter(c,{visualCoverageComplete:true,anonymousBackgroundOnly:true},closed).visualRequirement,'not_required')],
 ['当前排除决定可以被采用', () => assert.equal(r.decideCharacter(c,{visualCoverageComplete:true,exclusionDecisionCurrent:true,independentVisualIdentityRequired:false},closed).visualRequirement,'not_required')],
 ['派生不写回实体', () => {const source={...c,castingTier:'extra',assetRequired:false,voiceLibraryId:'old'};const copy=structuredClone(source);r.decideCharacter(source,{...visual,hasVocalEvent:true},closed);assert.deepEqual(source,copy);} ],
 ['历史布尔false不覆盖事实和声音', () => {const d=r.decideCharacter({...c,assetRequired:false},{...visual,hasVocalEvent:true},closed);assert.equal(d.visualRequirement,'required');assert.equal(d.voiceIdentityRequirement,'required');}],
 ['有效已有图走复用计划', () => {const d=r.decideCharacter(c,{...visual,currentVisualPassportValid:true});const p=r.partitionCharacters([d]);assert.deepEqual(p.reuseIds,['C1']);assert.deepEqual(p.generationCandidateIds,[]);}],
 ['pending既不生成也不消失', () => {const p=r.partitionCharacters([r.decideCharacter(c)]);assert.deepEqual(p.registryIds,['C1']);assert.deepEqual(p.pendingIds,['C1']);assert.deepEqual(p.generationCandidateIds,[]);}],
 ['非法状态禁止静默跳过', () => assert.throws(()=>r.partitionCharacters([{characterId:'C1',visualRequirement:'oops'}]),{code:'INVALID_CHARACTER_VIEW'})],
 ['重复身份禁止悄悄覆盖', () => assert.throws(()=>r.partitionCharacters([r.decideCharacter(c),r.decideCharacter(c)]),{code:'INVALID_CHARACTER_VIEW'})],
 ['空ID拒绝', () => assert.throws(()=>r.decideCharacter({id:''}),{code:'INVALID_ENTITY_ID'})],
 ['unknown兼容值为null但保留显式状态', () => assert.deepEqual(r.viewCompatibility(r.decideCharacter(c)),{visualRequirement:'unknown',assetRequired:null})],
 ['展示兼容布尔不能代表付费资格', () => {const d=r.decideCharacter(c,visual);assert.equal(r.viewCompatibility(d).assetRequired,true);assert.equal(Object.hasOwn(d,'authorized'),false);} ],
 ['非法内部choice拒绝', () => assert.throws(()=>r.decideCharacter(c,{}, {trustedVisualChoice:false}),{code:'INVALID_VISUAL_CHOICE'})],
];
for(const [name, fn] of cases) test(name, fn);

// 仅从本轮报告§3.1列出的字段提取。真实源账本/shotExecution必须由应用适配器另测。
const fixture = {
 characters:[
  {id:'C01',name:'顾云舟',castingTier:'lead'}, {id:'C02',name:'苏晚晴',castingTier:'lead'},
  {id:'C03',name:'银发女士甲'}, {id:'C04',name:'礼宾主管',voiceLibraryId:'voice_offscreen_old'},
  {id:'C05',name:'礼宾人员'}, {id:'C06',name:'路人甲',role:'背景人物'},
  {id:'C07',name:'银发女士乙',role:'舞会临时来宾',voiceLibraryId:'voice_extra_old'}],
 shots:[
  {id:'S01',visibleCharacterIds:['C01'],focusCharacterId:'C01'},
  {id:'S02',visibleCharacterIds:['C01','C02'],focusCharacterId:'C02'},
  {id:'S03',visibleCharacterIds:['C01','C02','C03','C07'],focusCharacterId:'C03',dialogueTurns:[{speakerId:'C07',text:'排队，我先看见的。',onScreen:true}]},
  {id:'S04',visibleCharacterIds:['C02','C06'],dialogueTurns:[{speakerId:'C04',onScreen:false,listenerIds:['C06']}],offscreenSpeakerIds:['C04']},
  {id:'S05',visibleCharacterIds:['C01','C02']},{id:'S06',visibleCharacterIds:['C01','C02']}]
};
function evidenceFromReport(id, complete) {
 let anyVisible=false, cameraOwned=false, visibleSpeaker=false, visibleNamedListener=false, hasVocalEvent=false, used=false;
 for (const shot of fixture.shots) {
  const visible=shot.visibleCharacterIds?.includes(id)===true;
  anyVisible ||= visible; cameraOwned ||= shot.focusCharacterId===id;
  used ||= visible || shot.focusCharacterId===id || shot.offscreenSpeakerIds?.includes(id)===true;
  hasVocalEvent ||= shot.offscreenSpeakerIds?.includes(id)===true;
  for (const turn of shot.dialogueTurns||[]) {
   if(turn.speakerId===id){hasVocalEvent=true;used=true;visibleSpeaker ||= turn.onScreen===true;}
   if(turn.listenerIds?.includes(id)){used=true;visibleNamedListener ||= visible;}
  }
 }
 return {anyVisible,cameraOwned,visibleSpeaker,visibleNamedListener,hasVocalEvent,hasTaskUse:used,
  hasPendingUse:false, offscreenOnly:hasVocalEvent && !anyVisible && !visibleSpeaker && !cameraOwned,
  visualCoverageComplete:complete,vocalCoverageComplete:complete,sourceRelationsComplete:complete};
}
function fixtureViews(complete) {return fixture.characters.map(c=>r.decideCharacter(c,evidenceFromReport(c.id,complete),{...closed,scopeVerified:complete}));}
test('原始字段提取C06听者责任',()=>assert.equal(evidenceFromReport('C06',true).visibleNamedListener,true));
test('原始字段提取C07非focus发言',()=>{const e=evidenceFromReport('C07',true);assert.equal(e.cameraOwned,false);assert.equal(e.visibleSpeaker,true);});
test('闭合小夹具必需集合包含C06和C07',()=>assert.deepEqual(r.partitionCharacters(fixtureViews(true)).requiredVisualIds,['C01','C02','C03','C06','C07']));
test('闭合小夹具C05非必需但仍保留',()=>{const p=r.partitionCharacters(fixtureViews(true));assert.ok(p.registryIds.includes('C05'));assert.ok(p.noAutomaticVisualIds.includes('C05'));});
test('未证明全范围时C05待核实且不自动生成',()=>{const p=r.partitionCharacters(fixtureViews(false));assert.deepEqual(p.pendingIds,['C04','C05']);assert.ok(!p.generationCandidateIds.includes('C05'));});
test('报告代码摘录没有C01台词不能补造事件',()=>assert.equal(evidenceFromReport('C01',true).hasVocalEvent,false));
test('未证明声音覆盖时C02声音unknown',()=>assert.equal(fixtureViews(false).find(x=>x.characterId==='C02').voiceIdentityRequirement,'unknown'));
test('夹具字段无写回',()=>{const before=structuredClone(fixture);fixtureViews(true);assert.deepEqual(fixture,before);});

function propContext(extra={}){return {projectId:'p',sourceRevision:'s1',scopeVerified:true,
 entities:new Map([['P02',{id:'P02',projectId:'p'}],['P03',{id:'P03',projectId:'p'}]]),
 confirmedAliases:new Map(),productIds:new Set(['sku1']),...extra};}
function mergeContext(extra={}){return propContext({mergeProofVerified:true,mergeProof:{kind:'same_physical_object',fromId:'P03',toId:'P02',projectId:'p',sourceRevision:'s1',evidenceId:'e1'},...extra});}
const propCases=[
 ['容器内容缺同物证据不合并',()=>{const d=r.decideProp({id:'P03',name:'深灰色审计文件夹'},{containsTargetId:'P02'},propContext());assert.equal(d.assetMergedIntoId,null);assert.equal(d.resourceRoute,'needs_evidence');}],
 ['裸confirmed布尔不构成证据',()=>assert.equal(r.decideProp({id:'P03'},{samePhysicalObjectConfirmed:true,samePhysicalObjectTargetId:'P02'},propContext()).resourceRoute,'needs_evidence')],
 ['别名证明齐全可复用',()=>assert.equal(r.decideProp({id:'P03'},{},mergeContext()).assetMergedIntoId,'P02')],
 ['同物证明与容器关系冲突待决策',()=>assert.equal(r.decideProp({id:'P03'},{containsTargetId:'P02'},mergeContext()).resourceRoute,'needs_decision')],
 ['过期同物证明拒绝',()=>assert.throws(()=>r.decideProp({id:'P03'},{},mergeContext({sourceRevision:'s2'})),{code:'MERGE_PROOF_INVALID'})],
 ['跨项目目标拒绝',()=>assert.throws(()=>r.decideProp({id:'P03'},{},mergeContext({entities:new Map([['P02',{projectId:'other'}]])})),{code:'MERGE_TARGET_INVALID'})],
 ['合并自环拒绝',()=>assert.throws(()=>r.validateMergeTarget('P03','P03',propContext()),{code:'MERGE_CYCLE'})],
 ['多级同物循环拒绝',()=>assert.throws(()=>r.decideProp({id:'P03'},{},mergeContext({confirmedAliases:new Map([['P02','P03']])})),{code:'MERGE_CYCLE'})],
 ['单次关键证物仍需独立表达',()=>assert.equal(r.decideProp({id:'paper',units:['S1']},{handheldEvidenceCritical:true},propContext()).resourceRoute,'prop')],
 ['核心商品保实体不另造道具图',()=>assert.equal(r.decideProp({id:'P03',coreStory:true},{},propContext({confirmedProductId:'sku1'})).resourceRoute,'product')],
 ['无效商品绑定拒绝',()=>assert.throws(()=>r.decideProp({id:'P03'},{},propContext({confirmedProductId:'missing'})),{code:'PRODUCT_BINDING_INVALID'})],
 ['两个矛盾商品绑定待决策',()=>assert.equal(r.decideProp({id:'P03'},{},mergeContext({confirmedProductId:'sku1',entities:new Map([['P02',{projectId:'p',confirmedProductId:'sku2'}]])})).resourceRoute,'needs_decision')],
 ['已证实无独立外观允许场景表达',()=>assert.equal(r.decideProp({id:'P03'},{coverageComplete:true,independentAppearanceNotNeeded:true},propContext()).resourceRoute,'inline')],
 ['视觉要求互相矛盾待决策',()=>assert.equal(r.decideProp({id:'P03',coreStory:true},{visualIdentityCritical:true,coverageComplete:true,independentAppearanceNotNeeded:true},propContext()).resourceRoute,'needs_decision')],
 ['needs_evidence不进入生道具队列',()=>assert.deepEqual(r.propConsumerPlan(r.decideProp({id:'P03'},{},propContext())),{generatePropCandidate:false,pending:true,legacyAssetRequired:null})],
 ['reuse不是无需任何资源',()=>{const d=r.decideProp({id:'P03'},{},mergeContext());assert.equal(d.visualRequirement,'required');assert.equal(r.propConsumerPlan(d).generatePropCandidate,false);assert.equal(d.resourceId,'P02');}],
 ['未知route直接拒绝',()=>assert.throws(()=>r.propConsumerPlan({resourceRoute:'default'}),{code:'INVALID_PROP_ROUTE'})],
 ['道具派生不写回实体',()=>{const p={id:'P03',name:'纸',assetRequired:null};const old=structuredClone(p);r.decideProp(p,{},propContext());assert.deepEqual(p,old);}]
];
for(const [name,fn] of propCases)test(name,fn);
for(const value of ['',false,0,[],{},'unknown','SPEED',null,undefined]) {
 test(`明确提交枚举拒绝${JSON.stringify(value)}`,()=>assert.throws(()=>r.validateIntent('priorityProfile',value),{code:'INVALID_INTENT_ENUM'}));
}
for(const [field, values] of Object.entries(r.INTENTS)) {
 test(`${field}的三个合法值保留`,()=>{for(const value of values)assert.equal(r.validateIntent(field,value),value);});
}
test('读取控件空串不能回退默认值（接口桩，不是DOM测试）',()=>assert.throws(()=>r.readIntentControls({querySelector:()=>({tagName:'SELECT',value:''})},'new'),{code:'INVALID_INTENT_ENUM'}));
test('控件缺失不能回退默认值（接口桩）',()=>assert.throws(()=>r.readIntentControls({querySelector:()=>null},'new'),{code:'INTENT_CONTROL_MISSING'}));

test('coreStory本身不是独立生图授权',()=>assert.equal(r.decideProp({id:'P03',coreStory:true},{},propContext()).resourceRoute,'needs_evidence'));
test('核心物件可由已证实场景资源表达',()=>assert.equal(r.decideProp({id:'P03',coreStory:true},{coverageComplete:true,independentAppearanceNotNeeded:true},propContext()).resourceRoute,'inline'));
test('视觉范围闭合但原稿引用未查全仅C05待核实',()=>{const views=fixture.characters.map(c=>r.decideCharacter(c,{...evidenceFromReport(c.id,true),sourceRelationsComplete:false},closed));assert.deepEqual(r.partitionCharacters(views).pendingIds,['C05']);});
