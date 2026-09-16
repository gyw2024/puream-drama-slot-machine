'use strict';
const reference=require('./commerce-reference-timing.json');
const DEFAULT_TARGET=reference.defaultTargetRatio;
function resolve(generation={}){
 const n=generation.commerceTargetRatio;
 // 20% was an internal default with no user-facing provenance. Preserve
 // explicit overrides and non-default imported targets, migrate only that default.
 if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1 && (n!==0.2||generation.commerceTargetSource==='user'))return n;
 return DEFAULT_TARGET;
}
module.exports={DEFAULT_TARGET,resolve,reference};
