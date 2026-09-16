'use strict';
// Recover one surplus structural object closer only when the screenplay schema
// identifies one unique result. Every string, property and primitive survives.
// No model call, content synthesis, verdict changes or partial-response promotion.
function tokens(s){return (s.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g)||[]).map(x=>JSON.parse(x));}
function recover(source){if(typeof source!=='string'||source.length>300000)return null;let quote=false,escape=false;const points=[];for(let i=0;i<source.length;i++){const c=source[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;}else if(c==='"')quote=true;else if(c==='}')points.push(i);}if(points.length>600)return null;
 const matches=new Map();let original;try{original=JSON.stringify(tokens(source));}catch{return null;}
 for(const at of points){try{const r=JSON.parse(source.slice(0,at)+source.slice(at+1));if(!r?.plan||!Array.isArray(r.plan.scenes)||!Array.isArray(r.parts)||!r.commerceProfile||r.plan.scenes.length!==r.parts.length||!r.parts.length||r.parts.some((p,i)=>p.sceneId!==r.plan.scenes[i].id))continue;
 // The requested screenplay schema places this ledger at the root. Without
 // that constraint an extra root closer could also be removed earlier and
 // silently relocate the whole ledger inside plan, giving two parses.
 if(/"continuityLedger"\s*:/.test(source)&&(!Array.isArray(r.continuityLedger)||r.plan.continuityLedger!==undefined))continue;
 const serialized=JSON.stringify(r);if(JSON.stringify(tokens(serialized))!==original)continue;matches.set(serialized,r);}catch{}}
 return matches.size===1?[...matches.values()][0]:null;
}
module.exports={recover};
