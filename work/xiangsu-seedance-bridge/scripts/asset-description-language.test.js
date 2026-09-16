'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sourceBackedPrintedLiterals,hasChineseNarrative}=require('../app/asset-description-language');
test('source-backed printed and handwritten labels tolerate sentence punctuation inside quotation marks',()=>{
 const source='桌牌正面写着“概不赊账”，随后在背面写下“互助登记”。';
 const en='The front bears the inscription “概不赊账.” Later she writes “互助登记,” on the reverse.';
 const terms=sourceBackedPrintedLiterals(en,source);
 assert.deepEqual(terms,['概不赊账','互助登记']);
 assert.equal(hasChineseNarrative(en,terms),false);
});
test('quoted Chinese narration and unsupported inscriptions remain rejected',()=>{
 const source='原稿有她走到桌边，桌牌写着互助登记。';
 for(const en of ['She says “她走到桌边.”','The inscription reads “杜撰商标.”']){
  const terms=sourceBackedPrintedLiterals(en,source);assert.deepEqual(terms,[]);assert.equal(hasChineseNarrative(en,terms),true);
 }
});
