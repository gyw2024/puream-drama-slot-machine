(function(root){
 'use strict';
 function commerceInputMode(project={}){
  return [project.product?.name,project.product?.imagePath].some(v=>String(v||'').trim())?'natural':'none';
 }
 if(typeof module==='object'&&module.exports)module.exports=commerceInputMode;
 else root.commerceInputMode=commerceInputMode;
})(typeof window==='object'?window:globalThis);
