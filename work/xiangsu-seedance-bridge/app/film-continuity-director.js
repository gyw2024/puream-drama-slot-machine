'use strict';
const {createHash}=require('node:crypto');
const VERSION='whole-film-physical-continuity-v4-generation-methods';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function source(p){return {script:p.script?.raw||'',shots:p.shots.map(s=>({id:s.id,sceneId:s.sceneId,action:s.action,stateBefore:s.stateBefore,stateAfter:s.stateAfter,dialogue:(s.dialogueTurns||[]).map(t=>({id:t.sourceDialogueId||t.id,speakerId:t.speakerId,text:t.text||t.spokenText}))})),characters:(p.characters||[]).map(x=>({id:x.id,name:x.name})),props:(p.assetLibraries?.props||[]).map(x=>({id:x.id,name:x.name,description:x.description})),scenes:(p.scenes||[]).map(x=>({id:x.id,description:x.description})),product:{name:p.product?.name,hasOriginalImage:!!p.product?.imagePath,visualEvidence:p.product?.visualEvidence||null}};}
const fingerprint=p=>hash({version:VERSION,...source(p)});
const text={type:'string',minLength:1};
function catalog(p){return String(p.script?.raw||'').split(/(?<=[。！？\n])/u).map(x=>x.trim()).filter(Boolean).map((text,i)=>({id:'Q'+String(i+1).padStart(4,'0'),text}));}
function schema(p){
 const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
 const ids=(p.assetLibraries?.props||[]).map(x=>x.id),quoteIds=catalog(p).map(q=>q.id);
 // The catalog belongs to the film, not to every alternative shot schema.
 // Keep one transport row and validate each returned row against its own shot.
 const speechIds=[...new Set(p.shots.flatMap(shot=>(shot.dialogueTurns||[]).map(t=>t.sourceDialogueId||t.id)))];
 const constraint=obj({dialogueId:speechIds.length?{type:'string',enum:speechIds}:text,relation:{type:'string',enum:['before','after','overlap']}});
 const action=obj({id:text,descriptionEn:text,sourceQuoteId:quoteIds.length?{type:'string',enum:quoteIds}:text,speechConstraints:{type:'array',items:constraint,...(speechIds.length?{}:{maxItems:0})}});
 const row=obj({shotId:{type:'string',enum:p.shots.map(s=>s.id)},openingEn:text,transitionsEn:text,endingEn:text,visiblePropIds:{type:'array',items:ids.length?{type:'string',enum:ids}:text,...(ids.length?{}:{maxItems:0})},offscreenEn:text,actions:{type:'array',items:action}});
 return obj({shots:{type:'array',minItems:p.shots.length,maxItems:p.shots.length,items:row}});
}
function validate(p,r){const props=new Set((p.assetLibraries?.props||[]).map(x=>x.id));if(!Array.isArray(r?.shots)||r.shots.length!==p.shots.length)throw Error('Continuity plan must cover every shot');for(const [i,row]of r.shots.entries()){if(row.shotId!==p.shots[i].id||['openingEn','transitionsEn','endingEn','offscreenEn'].some(k=>!String(row[k]||'').trim())||!Array.isArray(row.visiblePropIds)||new Set(row.visiblePropIds).size!==row.visiblePropIds.length||row.visiblePropIds.some(id=>!props.has(id)))throw Error('Invalid continuity plan at '+p.shots[i].id);const speechIds=new Set((p.shots[i].dialogueTurns||[]).map(t=>t.sourceDialogueId||t.id));if(!Array.isArray(row.actions)||new Set(row.actions.map(a=>a.id)).size!==row.actions.length||row.actions.some(a=>!a.id||!a.descriptionEn||!a.sourceQuote||!String(p.script?.raw||'').includes(a.sourceQuote)||!Array.isArray(a.speechConstraints)||a.speechConstraints.some(c=>!speechIds.has(c.dialogueId)||!['before','after','overlap'].includes(c.relation))))throw Error('Invalid source-grounded speech/action anchors at '+row.shotId);}return r;}
const INSTRUCTION=require('./generation-prompts').build("continuity");
async function plan({getProject,saveProject,generate,status=()=>{}}){const p=getProject();if(p.shots.length<2)return null;const signature=fingerprint(p);if(p.filmContinuityPlan?.fingerprint===signature){validate(p,p.filmContinuityPlan.result);return p.filmContinuityPlan.result;}
 status('正在由主 Agent 统一规划全片物件位置和跨镜状态，随后并行写分镜');
 const quotes=catalog(p);
 const providerGenerate=generate;
 generate=async(messages,options)=>{
  const completed=await require('./agent-item-contract').complete({items:p.shots.map(s=>({id:s.id})),cached:p.filmContinuityRecovery?.fingerprint===signature?p.filmContinuityRecovery.result:undefined,
   valid:row=>{for(const action of row.actions||[])if(action.sourceQuoteId)action.sourceQuote=quotes.find(q=>q.id===action.sourceQuoteId)?.text||'';validate({...p,shots:[p.shots.find(s=>s.id===row.shotId)]},{shots:[row]});return true;},
   generate:async(pending,repair)=>{
    if(fingerprint(getProject())!==signature)throw Object.assign(Error('Source changed while recovering continuity'),{code:'AGENT_SOURCE_CHANGED'});
    const ids=new Set(pending.map(s=>s.id)),scope={...p,shots:p.shots.filter(s=>ids.has(s.id))};
    const result=await providerGenerate([...messages,{role:'user',content:JSON.stringify({requestedShotIds:[...ids],repair,instruction:'Keep complete-film context, but return ONLY these requested shots. Preserve accepted rows; resolve invalid references or source quotes from the original source catalog. Do not invent IDs or repeat a failed interpretation.'})}],{...options,responseSchema:schema(scope)});
    return {items:(result.shots||[]).map(row=>({...row,id:row.shotId}))};
   },save:result=>{const latest=getProject();if(fingerprint(latest)!==signature)throw Object.assign(Error('Source changed while saving continuity recovery'),{code:'AGENT_SOURCE_CHANGED'});latest.filmContinuityRecovery={fingerprint:signature,result,at:new Date().toISOString()};saveProject(latest);}});
  if(completed.missingIds.length)throw Object.assign(Error('Continuity source reconciliation remains incomplete'),{code:'FILM_CONTINUITY_INCOMPLETE',missingIds:completed.missingIds});
  return {shots:completed.items.map(({id,...row})=>row)};
 };
 const r=await generate([{role:'system',content:INSTRUCTION+' ORIGINAL SOURCE AUTHORITY: derived stateBefore/stateAfter fields are analysis hints, not user-authored facts. The original scene ending wins when a hint conflicts. Never make a previous shot finish a later action merely to match a later opening. A cut may imply elapsed time: retain the actual source ending, then put necessary source-supported transition in the later shot or describe the source-implied elapsed interval. Do not turn a synopsis, theme, future-scene quote or story ending into an action in the current shot. Match every action quote to the particular scene that actually performs it. A sentence about an elevator still rising must not become completed ascent, released buttons or pocketed radio at that same ending. Audit each proposed transition against the assigned shot before returning. For each shot also return actions: one stable ID for each source-required physical action, a concise descriptionEn, sourceQuoteId selected from sourceCatalog, and speechConstraints referencing immutable dialogue IDs IN THIS SAME SHOT. Do not retype or paraphrase a quote. before means the action must finish before that utterance begins; after means it may start only after that utterance ends; overlap means source explicitly makes the action concurrent with the utterance. Use an empty constraints list when source does not constrain it; do not invent rigid timing. Separate offering from the receiver securing/releasing a handoff when dialogue falls between them. Necessary physical constituents may share the original action quote ID. This plan is a source-grounded hypothesis, never permission to override the source.'},{role:'user',content:JSON.stringify({...source(p),sourceCatalog:quotes})}],{agentStage:'planning',json:true,requiredKeys:['shots'],responseSchema:schema(p),maxAttempts:1,maxTokens:24000});
 const latest=getProject();if(fingerprint(latest)!==signature)throw Object.assign(Error('Source changed while planning continuity'),{code:'AGENT_SOURCE_CHANGED'});
 for(const row of r.shots||[])for(const action of row.actions||[])if(action.sourceQuoteId)action.sourceQuote=quotes.find(q=>q.id===action.sourceQuoteId)?.text||'';
 latest.filmContinuityAttempts=[...(latest.filmContinuityAttempts||[]),{fingerprint:signature,result:r,at:new Date().toISOString()}];saveProject(latest);validate(p,r);
 if(latest.filmContinuityPlan)latest.filmContinuityPlanHistory=[...(latest.filmContinuityPlanHistory||[]),latest.filmContinuityPlan];latest.filmContinuityPlan={version:VERSION,fingerprint:signature,result:r,authoredAt:new Date().toISOString()};saveProject(latest);return r;}
module.exports={VERSION,source,fingerprint,schema,validate,INSTRUCTION,plan};
