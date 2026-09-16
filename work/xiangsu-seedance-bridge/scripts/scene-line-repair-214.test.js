'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {applySceneRepair}=require('../app/adaptive-script-author');
const original={sceneId:'S1',scriptText:'untouched opening\nold action\nuntouched dialogue\nold ending',endState:'old'};
test('blank separators do not turn five substantive lines into a forbidden full scene rewrite',()=>{const source={sceneId:'S1',scriptText:'header\na\n\nb\nc\nd\ne\nunchanged tail',endState:'old'};const result=applySceneRepair(source,{sceneId:'S1',replacements:[{fromLine:2,toLine:7,after:'five repaired lines'}],endState:'new'});assert.equal(result.scriptText,'header\nfive repaired lines\nunchanged tail');assert.throws(()=>applySceneRepair({...source,scriptText:source.scriptText.replace('\n\nb','\nf\nb')},{sceneId:'S1',replacements:[{fromLine:2,toLine:7,after:'x'}],endState:'new'}));});
test('line repairs preserve all text outside their disjoint ranges',()=>{
 const result=applySceneRepair(original,{sceneId:'S1',replacements:[{fromLine:4,toLine:4,after:'new ending'},{fromLine:2,toLine:2,after:'new action\nadded cue'}],endState:'new'});
 assert.equal(result.scriptText,'untouched opening\nnew action\nadded cue\nuntouched dialogue\nnew ending');
 assert.equal(original.scriptText,'untouched opening\nold action\nuntouched dialogue\nold ending');
});
test('line repairs reject overlapping or out-of-bounds ranges without changing source',()=>{
 for(const replacements of [[{fromLine:0,toLine:1,after:'x'}],[{fromLine:1,toLine:5,after:'x'}],[{fromLine:2,toLine:3,after:'x'},{fromLine:3,toLine:4,after:'y'}]])assert.throws(()=>applySceneRepair(original,{sceneId:'S1',replacements,endState:'new'}));
 assert.equal(original.endState,'old');
});
