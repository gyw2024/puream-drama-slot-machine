'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),language=require('../app/asset-description-language');
test('source-backed literal identifiers preserve physical identification contexts',()=>{
 const source='贴好编号二零七后才松手。';
 for(const prose of ['The temporary identifier “二零七”.','The crate is labeled “二零七”.','Its marking is “二零七”.']){
  const literals=language.sourceBackedPrintedLiterals(prose,source);
  assert.deepEqual(literals,['二零七']);assert.equal(language.hasChineseNarrative(prose,literals),false);
 }
 assert.equal(language.hasChineseNarrative('The crate “捏造标签”.',language.sourceBackedPrintedLiterals('The crate “捏造标签”.',source)),true);
 assert.equal(language.hasChineseNarrative('箱子贴好编号二零七。',language.sourceBackedPrintedLiterals('箱子贴好编号二零七。',source)),true);
});
