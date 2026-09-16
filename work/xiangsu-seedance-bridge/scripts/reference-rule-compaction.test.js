const test=require('node:test'),assert=require('node:assert/strict'),{compact}=require('../app/reference-rule-compaction');
test('large reference manifests preserve every binding and all authored content when factoring identical rules',()=>{
 const ids=Array.from({length:25},(_,i)=>i+1),body='An authored actor moves once. '.repeat(190)+'<d>[Chinese] 原文不能删改。</d>';
 const definitions=ids.map(i=>`<Subject ${i}> is prop prop_${i}: exact appearance/scale from <Picture ${i}>; holder/state follow authored actions.`).join('\n');
 const retention=ids.map(i=>`<Subject ${i}>: fully_preserved - stable appearance/scale; only authored holder/state changes.`).join('\n');
 const prompt=`subject_definitions:\n${definitions}\nsummary:\nA scene.\nretention_analysis:\n${retention}\ndetailed_description:\n${body}\noverall_soundscape:\nRoom tone.\nnon_diegetic_music:\nN/A`;
 assert.ok(prompt.length>10000);const result=compact(prompt);assert.ok(result.length<10000);assert.ok(result.includes(body));
 for(const i of ids){assert.ok(result.includes(`<Subject ${i}> is prop prop_${i} from <Picture ${i}>.`));assert.ok(result.includes(`<Subject ${i}>: fully_preserved - prop rule below.`));}
 assert.match(result,/exact referenced appearance and scale, kept stable; holder and physical state change only through the authored action timeline/);
});
test('ordinary prompts and unknown prose are untouched',()=>{assert.equal(compact('short'),'short');const x='x'.repeat(10001);assert.equal(compact(x),x);});
