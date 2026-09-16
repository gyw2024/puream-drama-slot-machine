'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const evidence=require('../app/prompt-review-evidence');
const {reviewBatchSource}=require('../app/agent-stage-tasks');
test('original and regrouped equal shot labels retain separate evidence ownership',()=>{
 const source={script:'S38: Original borrowing scene.\nS65: Final family lesson.',shots:[{id:'S38',action:'Final family lesson.',sourceDialogueBindings:[{sourceDialogueId:'D120',text:'The family lesson.'}],dialogueTurns:[]}]};
 const batch=[{id:'shot:S38:video',entityType:'shot',entityId:'S38',stage:'shot_video',group:'videos',prompt:'Final family lesson.'}];
 const scoped=reviewBatchSource(source,batch),facts=evidence.catalog(scoped);
 assert.equal(scoped.script,source.script);
 assert.deepEqual(scoped.shots[0].sourceDialogueBindings,source.shots[0].sourceDialogueBindings);
 const original=facts.find(f=>f.text==='S38: Original borrowing scene.');
 assert.equal(original.context.namespace,'original_screenplay');assert.equal(original.context.shotNumberAuthority,false);
 const canonical=facts.find(f=>f.text==='Final family lesson.');
 assert.equal(canonical.context.namespace,'canonical_production');assert.equal(canonical.context.entityId,'S38');
 const bound=facts.find(f=>f.text==='The family lesson.');assert.equal(bound.context.sourceDialogueId,'D120');
 assert.match(evidence.INSTRUCTION,/Equal|equal numeric/);
 assert.equal(scoped.shotIdentityContract.originalNamespace,'original_screenplay');
});
