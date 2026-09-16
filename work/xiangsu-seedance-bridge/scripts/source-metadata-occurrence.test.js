const test=require('node:test'),assert=require('node:assert/strict');
const {parseSourceDialogueLedger}=require('../app/dialogue-parser');
const {sourceSpeechTiming}=require('../app/staged-upload-preparation');
test('bracketed front matter is not speech, and separate repeated utterances remain separate',()=>{
 const source=['【人物】','韩雪：32岁，志愿者。','陆振华：70岁，退休队长。','【场景】','小书房（整理后）：桌面明亮整洁。','# 正式剧情','第1场 客厅 日','韩雪（对陆振华；急问）：您还好吗？','陆振华（对韩雪；清楚）：我没有事。','韩雪（对陆振华；急问）：您还好吗？'].join('\n');
 const rows=parseSourceDialogueLedger(source,['韩雪','陆振华']);
 assert.deepEqual(rows.map(r=>[r.speaker,r.text]),[['韩雪','您还好吗？'],['陆振华','我没有事。'],['韩雪','您还好吗？']]);
 assert.ok(rows[0].sourceStart<rows[2].sourceStart);assert.deepEqual(rows.map(r=>r.id),['D001','D002','D003']);
 assert.deepEqual(sourceSpeechTiming(source.split('\n')).map(r=>r.text),rows.map(r=>r.text));
});
test('metadata quoting speech does not leak through narrative or standalone fallback scans',()=>{
 const source='## 人物小传\n韩雪：志愿者，常说“别害怕”。\n陆振华\n总爱说你好。\n【剧情】\n韩雪低声说：“别害怕”。\n韩雪低声说：“别害怕”。';
 const rows=parseSourceDialogueLedger(source,['韩雪','陆振华']);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>({speaker:r.speaker,text:r.text})),Array.from({length:2},()=>({speaker:'韩雪',text:'别害怕'})));
});
test('formal parenthetical speaker ownership outranks listener mentions and physical photo descriptions are not speech',()=>{
 const rows=parseSourceDialogueLedger('韩雪（对陆振华；低声安抚；陆振华将笔记揽入怀中）：“别慌，您先抱好。”\n张秀兰（对韩雪；看向韩雪，继续低声解释）：“这里不是废品。”\n韩雪低头展开老照片：第一张是队长的合影，照片背面是一行字：“满月留念。”',['韩雪','陆振华','张秀兰']);
 assert.deepEqual(rows.map(r=>[r.speaker,r.text]),[['韩雪','别慌，您先抱好。'],['张秀兰','这里不是废品。']]);
});
