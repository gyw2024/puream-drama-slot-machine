'use strict';
// Select explicit canonical dependencies; never infer asset facts from wording.
function source(project,entities){
 const record=project.script?.shotScreenplay,doc=record?.document;
 if(!doc||!require('./shot-screenplay').runtimeCurrent(project))return {script:project.script?.raw||'',scope:'legacy-full-source'};
 return fromDocument(doc,entities)||{script:project.script?.raw||'',scope:'unmapped-full-source'};
}
function fromDocument(doc,entities){
 const ids=new Set(entities.map(e=>e.id)),rows={};
 for(const key of ['characters','scenes','props','wardrobes'])rows[key]=(doc[key]||[]).filter(e=>ids.has(e.id));
 const found=new Set(Object.values(rows).flat().map(e=>e.id));
 if(entities.some(e=>!found.has(e.id)))return null;
 const shots=(doc.shots||[]).filter(s=>[s.sceneId,...(s.characterIds||[]),...(s.visibleCharacterIds||[]),...(s.propIds||[]),...(s.wardrobeBindings||[]).flatMap(w=>[w.characterId,w.wardrobeId]),...(s.dialogue||[]).flatMap(d=>[d.speakerId,...(d.listenerIds||[])])].some(id=>ids.has(id)));
 return structuredClone({scope:'canonical-asset-dependencies',...rows,shots});
}
module.exports={source,fromDocument};
