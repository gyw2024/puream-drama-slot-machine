const test=require('node:test'),assert=require('node:assert/strict');
const {resolvePrimaryListener,canonicalizeStagingShot}=require('../app/drama-staging-contract');
const {uniqueDialogueTurns,h3AssetDirectSemanticSource,parseAiStandardizedProductionScript}=require('../app/workbench-workflow');
const characters=[{id:'C01',name:'陈远'},{id:'C02',name:'赵淑芳'},{id:'C03',name:'梁志刚'}];
test('explicit parenthetical addressee beats stale array-order listener and viewer remains viewer',()=>{
 const project={characters},turn={sourceDialogueId:'D008',speakerId:'C03',sourceTone:'对陈远；好奇',text:'多少钱？我也想给家里带两罐。',listenerIds:['C02'],primaryListenerId:'C02'};
 assert.equal(resolvePrimaryListener(project,{},turn).id,'C01');
 const fixed=canonicalizeStagingShot(project,{},[turn]).turns[0];assert.deepEqual(fixed.listenerIds,['C01']);assert.match(fixed.speakerFacingEn,/C01/);
 const viewer=canonicalizeStagingShot(project,{},[{...turn,sourceTone:'手持商品，面向观众；清楚利落'}]).turns[0];assert.equal(viewer.directToViewer,true);assert.deepEqual(viewer.listenerIds,[]);assert.equal(viewer.primaryListenerId,'');
 const normalized=uniqueDialogueTurns(project,{dialogueTurns:[viewer]})[0];assert.equal(normalized.directToViewer,true);assert.equal(normalized.addressMode,'viewer');
 const semantic=h3AssetDirectSemanticSource({...project,shots:[{id:'S01',duration:15,dialogueTurns:[turn]}]});assert.equal(semantic.shots[0].dialogue[0].primaryListenerId,'C01');assert.deepEqual(semantic.shots[0].dialogue[0].listenerIds,['C01']);
});
test('parser and immutable source reconciliation do not replace exact listener with first other cast member',()=>{
 const raw='### S01｜场景：家\n【人物】赵淑芳、陈远、梁志刚\n【核心物品】无\n【动作】陈远拿着礼物。\n【对白】梁志刚（对陈远；好奇）：多少钱？\n【对白】陈远（面向观众；清楚）：欢迎了解。\n【声音】室内底噪\n【承接】三人仍在桌边。';
 const parsed=parseAiStandardizedProductionScript(raw,{script:{raw}}),shot=parsed.shots[0];
 const owner=parsed.characters.find(c=>c.name==='陈远').id;
 assert.deepEqual(shot.dialogueTurns[0].listenerIds,[owner]);
 assert.equal(shot.dialogueTurns[1].directToViewer,true);assert.deepEqual(shot.dialogueTurns[1].listenerIds,[]);
});
