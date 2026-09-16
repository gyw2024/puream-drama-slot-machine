'use strict';
// Existing authoring tests retain their simulated rejection; this is a test
// Agent receipt, never a production default or a semantic implementation.
module.exports=messages=>{const p=JSON.parse(messages[1].content),c=p.primaryConclusion;return {decisions:Object.fromEntries(p.findings.map(f=>[f.id,{verdict:'upheld',reason:'Test reviewer independently upholds this fixture defect from its supplied source.'}])),conclusion:{ok:false,storyComplete:c.storyComplete!==false,sourcePreserved:c.sourcePreserved!==false,criteria:c.criteria||Object.fromEntries(['story','commerce','dialogue'].map(k=>[k,{passed:true,evidence:'Fixture retains previous scoped criterion.'}]))}};};
