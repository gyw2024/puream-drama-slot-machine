'use strict';
function hasChineseNarrative(text,literals=[]){
 let prose=String(text||'');for(const term of literals.filter(t=>typeof t==='string'&&t.trim()).sort((a,b)=>b.length-a.length))prose=prose.split(term).join('');
 return /[\u3400-\u9fff]/u.test(prose);
}
function normalizeEntityNames(value,entities=[],literals=[]){
 let text=String(value||''),replacements=[];const protectedText=[];
 for(const term of literals.filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(term).join(`__LOCKED_LITERAL_${protectedText.push(term)-1}__`);
 const names=new Map();for(const e of entities)if(e.name&&e.id){if(!names.has(e.name))names.set(e.name,new Set());names.get(e.name).add(e.id);}
 for(const [name,ids] of [...names].sort((a,b)=>b[0].length-a[0].length))if(ids.size===1&&/[\u3400-\u9fff]/u.test(name)&&text.includes(name)){const id=[...ids][0];text=text.split(name).join(id);replacements.push({name,id});}
 text=text.replace(/__LOCKED_LITERAL_(\d+)__/g,(_,i)=>protectedText[Number(i)]);
 return {text,replacements};
}
function sourceInscriptionLiterals(source){return [...String(source||'').matchAll(/(?:写着|写有|印着|印有|刻着|刻有|标着|标有|标为|命名为|标签为|原文)[“"‘']?([\u3400-\u9fff]{1,24})(?=[”"’'，。！？…；\n]|$)/gu)].map(m=>m[1]);}
function sourceBackedPrintedLiterals(description,source){
 const text=String(description||''),terms=[];
 for(const m of text.matchAll(/[“"‘']([\u3400-\u9fff]{1,80})[.,，。!?！？]?[”"’']/gu)){
  const context=text.slice(Math.max(0,m.index-100),m.index);
  if(/(?:reads?|printed|printing|heading|inscription|label(?:ed|led)?|identifier|identification|marking|numbered|allegation|body text|writes?|written|handwritten|source-required)\b[^.!?]*$/i.test(context)&&String(source||'').includes(m[1]))terms.push(m[1]);
 }
 return [...new Set(terms)];
}
function observedProductEvidence(product){
 const evidence=product?.visualEvidence;
 if(evidence?.status!=='observed'||!evidence.sha256||!product.imagePath)return null;
 const fs=require('node:fs'),crypto=require('node:crypto');
 try{if(crypto.createHash('sha256').update(fs.readFileSync(product.imagePath)).digest('hex')!==evidence.sha256)return null;}catch{return null;}
 return evidence;
}
function observedProductLiterals(product){
 const evidence=observedProductEvidence(product);if(!evidence)return [];
 // Only observed print is exempt, never arbitrary Chinese narrative supplied
 // by the author. Punctuation and digits are part of a package inscription.
 const text=[evidence.packagingDescriptionEn,...(evidence.visibleParts||[])].join('\n');
 return [...new Set([...text.matchAll(/[“"‘']([^“”"‘’'\r\n]{1,100})[”"’']/gu)].map(m=>m[1]).filter(t=>/[\u3400-\u9fff]/u.test(t)))];
}
module.exports={hasChineseNarrative,normalizeEntityNames,sourceInscriptionLiterals,sourceBackedPrintedLiterals,observedProductLiterals,observedProductEvidence};
