'use strict';
const words=text=>(String(text).replace(/<d>[\s\S]*?<\/d>/gi,'').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]).length;
function stub(source){return {shotId:source.shotId,openingEn:'X',openingZh:'起',secondCameraEn:'X',secondCameraZh:'转',endingEn:'X',endingZh:'终',summaryEn:'X',soundscapeEn:'X',turns:source.dialogue.map(t=>({sourceDialogueId:t.sourceDialogueId,directionEn:'X',directionZh:'动作'}))};}
function deliveryFixedWords(source,project,shot){
 if(!project||!source.requiredCameraLayout)return undefined;
 const editor=require('./h3-final-prompt-editor'),wf=require('./workbench-workflow'),item=require('./final-prompt-blocks').assemble(source,stub(source));
 const draft={...shot,finalPromptEditing:{...item,status:'authored',fingerprint:editor.fingerprint(shot),compilerVersion:'state-scoped-v3'}},p={...project,shots:project.shots.map(s=>s.id===shot.id?draft:s)};
 const refs=wf.promptReviewReferencePlan(p,draft,p.generation?.mode,'image_only'),prompt=wf.renderApprovedVideoPrompt(p,draft,refs),body=prompt.match(/(?:detailed_description|integrated_multimodal_description):\s*\n([\s\S]*?)(?=\noverall_soundscape:|$)/)?.[1];
 return body?words(body)-3-source.dialogue.length:undefined;
}
function forSource(source){
 const n=source.dialogue.length||1,fixedWords=source.requiredCameraLayout?words(require('./final-prompt-blocks').assemble(source,stub(source)).detailedDescriptionEn)-3-n:0;
 const overhead=source.deliveryFixedWords??fixedWords+65;
 // One shared budget with alternate allocations, including final references.
 const available=Math.max(40,470-overhead);
 const profiles=[[25,25],[45,30],[30,50]].map(([openingEn,endingEn])=>({openingEn,secondCameraEn:18,endingEn,directionEn:Math.max(1,Math.floor((available-openingEn-endingEn-18)/n))}));
 return {...profiles[0],profiles,fixedWords,deliveryFixedWords:overhead,recommendedAuthoredWords:available,preferredCompiledWords:470,recommendedCompiledWords:500,policy:'Writing targets only. Preserve complete source action and dialogue; do not truncate to reach a word count.'};
}
function schema(sources){
 const base=require('./stage-output-schemas').finalBlocks(),shape=base.properties.items.items;
 const alternatives=sources.flatMap(source=>forSource(source).profiles.map(profile=>{const item=structuredClone(shape),p=item.properties;p.shotId={type:'string',const:source.shotId};for(const key of ['openingEn','secondCameraEn','endingEn'])delete p[key].pattern;delete p.turns.items.properties.directionEn.pattern;p.turns.minItems=source.dialogue.length;p.turns.maxItems=source.dialogue.length;return item;}));
 base.properties.items={type:'array',minItems:sources.length,maxItems:sources.length,items:{anyOf:alternatives}};return base;
}
function pattern(max){return '^\\s*(?:\\S+\\s+){0,'+Math.max(0,max-1)+'}\\S+\\s*$';}
module.exports={forSource,schema,words,deliveryFixedWords};

