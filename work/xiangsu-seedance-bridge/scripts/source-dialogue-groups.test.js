const test=require('node:test'),assert=require('node:assert/strict');const {groups}=require('../app/source-dialogue-groups');
test('splits overloaded scenes without omitting or reordering exact dialogue IDs',()=>{
 const atoms=Array.from({length:16},(_,i)=>({id:`D${i}`,turnId:`turn${i}`,speaker:'老周',text:'这些东西都是你父亲当年留下来的，你一定要好好保存。',sourceSceneName:i<8?'客厅':'院子'}));
 const rows=groups(atoms);assert.ok(rows.length>2);assert.deepEqual(rows.flatMap(r=>r.dialogueIds),atoms.map(r=>r.id));assert.ok(rows.every(r=>r.speechSeconds.min<=13.5));
 for(const row of rows)assert.equal(new Set(row.dialogueIds.map(id=>atoms.find(a=>a.id===id).sourceSceneName)).size,1);
});
test('rejects a physically impossible single sentence instead of changing words',()=>assert.throws(()=>groups([{id:'D001',text:'长'.repeat(500),speaker:'老周',turnId:'T1',sourceSceneName:'院子'}]),/单句对白/));
