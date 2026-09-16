const test=require('node:test'),assert=require('node:assert/strict');
const {parseSourceDialogueLedger}=require('../app/dialogue-parser'),{catalog}=require('../app/indexed-production-plan'),{groups}=require('../app/source-dialogue-groups');
test('declared actors outrank adverbs and repeated quotes keep their actual speakers and source shots',()=>{
 const source='人物：陈岩，30岁男性；周梅，55岁女性。\nS01｜0-10秒：陈岩指着茶袋，迟疑地问：“还没打开？”周梅抬头看他，语气温柔：“等你回来喝。”\nS02｜10-20秒：陈岩接杯，放松地说：“这花香，还是家的味道。”周梅微笑：“陪我坐会儿。”';
 const rows=parseSourceDialogueLedger(source);
 assert.deepEqual(rows.map(r=>r.speaker),['陈岩','周梅','陈岩','周梅']);
 assert.deepEqual(rows.map(r=>r.text),['还没打开？','等你回来喝。','这花香，还是家的味道。','陪我坐会儿。']);
 assert.deepEqual(rows.map(r=>r.sourceShotId),['S01','S01','S02','S02']);
 assert.equal(groups(catalog(rows)).length,2);
});
