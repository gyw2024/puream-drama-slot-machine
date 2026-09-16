'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeAgeBand,characterAgeBand}=require('../app/asset-eligibility');
test('Agent age group aliases survive normalization instead of falling back to stale numeric age',()=>{
 for(const alias of ['young adult','young_adult','young-adult','Young Adult']){
  assert.equal(normalizeAgeBand(alias),'青年');
  assert.equal(characterAgeBand({ageBand:alias,age:45,role:'年轻邻居'}),'青年');
 }
 assert.equal(characterAgeBand({ageBand:'older adult',age:45}),'老年');
 assert.equal(normalizeAgeBand('middle-aged'),'中年');
});
