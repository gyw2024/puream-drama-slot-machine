'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {bindEvidenceClock}=require('../app/commerce-editorial-contract');
test('exact unique source utterance owns timing without changing evidence receipt',()=>{
 const units=[{id:'S1',turns:[{text:'完整商品台词',start:2,end:5}]}];
 const report={editorial:{intervals:[{unitId:'S1',quote:'完整商品台词',start:3,end:4}]}};
 const result=bindEvidenceClock(units,report);
 assert.equal(result.editorial.intervals[0].start,3);assert.equal(result.editorial.intervals[0].end,4);
 assert.equal(report.editorial.intervals[0].end,4);
});
test('partial and ambiguous evidence cannot acquire a whole utterance clock',()=>{
 const row={unitId:'S1',quote:'商品',start:0,end:12};
 assert.deepEqual(bindEvidenceClock([{id:'S1',turns:[{text:'完整商品台词',start:2,end:5}]}],{editorial:{intervals:[row]}}).editorial.intervals[0],row);
 const turns=[{text:'商品',start:1,end:2},{text:'商品',start:4,end:5}];
 assert.deepEqual(bindEvidenceClock([{id:'S1',turns}],{editorial:{intervals:[row]}}).editorial.intervals[0],row);
});
