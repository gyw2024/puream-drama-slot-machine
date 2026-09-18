"use strict";
const {speechWindowBounds}=require('./drama-timing');
const VERSION='source-performance-budget-v8-editorial-advisory';
const DIRECTIVE=`Before grouping source dialogue into 10–15 second production units, budget displayed physical performance, not just speaking. Return performanceBudgets:[{shotId:"S01",actionPhases:[{phase:"before|during|after",action:"specific original physical beat",seconds:2.6,reason:"distance/contact/result or explicit speech overlap"}]}] alongside productionScript. Every unit has at least one complete source sentence. The before/after phases mean ONLY before the FIRST utterance and after the LAST utterance of this whole shot. All compatible gesture, handoff, clothing placement, walking and object-display actions must overlap speech in during phases. A descriptive action prefix before a colon does not force the actor to remain silent until every action finishes. Preserve causal physical preparation/contact/result, but retime compatible actions under the same original dialogue; only explicit source words such as after finishing then says lock speech after the action. Do not add long silent emotional preparation. The during phase covers the interior from first voice onset to last voice ending; a real gap between complete utterances may contain a physical action, but every such gap must be at most 3 seconds. This interior span is not the sum of spoken syllable durations. State exact startSeconds/endSeconds for actions and identify any internal silent gap in its reason. Final per-utterance timing independently validates speech rate and every silence. Different sequential visible actions get separate phases; concurrent during-speech motion needs explicit physical justification. Use realistic walking, crouching, pickup, evidence-checking and handoff durations. Plan a clean speech onset and complete ending; 0.30/0.35 seconds are suggestions, not hard limits. Actions may overlap speech. Dialogue is 5–6 effective Chinese characters/sec, arguments at least 8; numerical prices must budget their fully pronounced syllables. If two complete sentences plus their actions cannot fit 15 seconds, use separate consecutive S units with one sentence each and carry actual state forward. Never solve overflow with accelerated motion, undeclared jump cuts, missing essential contact/results, invented words, slow dialogue or a silent provider unit. Budget screen time, not all elapsed story time: a half-hour delivery delay does NOT require half an hour of real-time footage. Waiting, routine travel and repetitive nonessential handling may use a clearly declared editorial ellipsis BETWEEN complete meaningful beats, never through a spoken sentence or the preparation/contact/result of a key action. Show the causal action and its later result, preserve object/person state, explicitly state the elapsed-time cut, and count both visible parts. Do not invent essential events to explain the elapsed time. A long speech paragraph may be divided only at complete original sentence boundaries without changing any word or speaker. 【承接】 records the resulting visible state and next boundary; it must not hide additional unbudgeted visible actions. Preserve source order and words. If the source truly cannot fit these constraints, report sourceTimingIssues with its exact source excerpt instead of claiming capacity.`;
function evaluateBudget(row,turns){
 const phases=Array.isArray(row?.actionPhases)?row.actionPhases:[];
 const issues=[],advisories=[];
 if(!phases.length)issues.push('missing explicit physical action phases');
 for(const p of phases)if(!['before','during','after'].includes(p.phase)||!String(p.action||'').trim()||!String(p.reason||'').trim()||!Number.isFinite(p.seconds)||p.seconds<0)issues.push('invalid action phase or missing rationale');
 const sum=phase=>phases.filter(p=>p.phase===phase).reduce((n,p)=>n+(Number(p.seconds)||0),0);
 const speechBounds=turns.map(t=>speechWindowBounds(t.text||t.spokenText,t));
 const targetSpeechSeconds=speechBounds.reduce((n,b)=>n+b.targetSeconds,0);
 const minSpeechSeconds=speechBounds.reduce((n,b)=>n+b.minSeconds,0);
 const maxSpeechSeconds=speechBounds.reduce((n,b)=>n+b.maxSeconds,0);
 const beforeSeconds=sum('before'),afterSeconds=sum('after'),duringSeconds=sum('during');
 const maxInteriorGapSeconds=3*Math.max(0,turns.length-1);
 if(duringSeconds>maxSpeechSeconds+maxInteriorGapSeconds+0.05)advisories.push('interior actions exceed speech plus preferred inter-utterance gaps; review pacing against source action');
 const outsideSeconds=beforeSeconds+afterSeconds;
 if(beforeSeconds>3.01||afterSeconds>3.01)advisories.push('continuous silence exceeds 3s; review meaningful source action and emotional pacing');
 // Interior screen time includes legal gaps; it is not all voiced time.
 const minimumVoicedInterior=Math.max(0,duringSeconds-maxInteriorGapSeconds);
 let speechSeconds=Math.max(targetSpeechSeconds,Math.min(minimumVoicedInterior,maxSpeechSeconds));
 // 5.5 cps is a preference inside 5-6, not an immutable constraint. Try a
 // legal faster delivery before declaring source actions impossible.
 const fastestCompatibleSpeech=Math.max(minSpeechSeconds,Math.min(minimumVoicedInterior,maxSpeechSeconds));
 if(speechSeconds+outsideSeconds>15&&fastestCompatibleSpeech+outsideSeconds<=15+1e-8)
  speechSeconds=Math.max(fastestCompatibleSpeech,15-outsideSeconds);
 const requiredSeconds=Math.max(10,Math.ceil(Math.max(speechSeconds,duringSeconds)+outsideSeconds-1e-8));
 const effectiveOutside=outsideSeconds>0?outsideSeconds:(turns.length?0.65:0);
 if(duringSeconds>15)issues.push(`complete source speech and sequential actions need ${Math.ceil(duringSeconds+effectiveOutside)}s; regroup complete lines before compiling`);
 if(requiredSeconds>15)advisories.push(`complete source speech and sequential actions need ${requiredSeconds}s; regroup complete lines before compiling`);
 return {version:VERSION,shotId:row?.shotId||'',speechSeconds:Number(speechSeconds.toFixed(2)),minSpeechSeconds:Number(minSpeechSeconds.toFixed(2)),targetSpeechSeconds:Number(targetSpeechSeconds.toFixed(2)),maxSpeechSeconds:Number(maxSpeechSeconds.toFixed(2)),beforeSeconds,afterSeconds,duringSeconds,maxInteriorGapSeconds,requiredSeconds,actionPhases:phases,issues,advisories};
}
function preferredSpeechSeconds(turn,turns,budget){
 const bounds=speechWindowBounds(turn.text||turn.spokenText,turn),requested=Number(budget?.speechSeconds);
 if(!Number.isFinite(requested)||requested<=0)return bounds.targetSeconds;
 const all=turns.map(t=>speechWindowBounds(t.text||t.spokenText,t)),sum=key=>all.reduce((n,b)=>n+b[key],0);
 const target=sum('targetSeconds'),side=requested<target?'minSeconds':'maxSeconds',limit=sum(side);
 if(Math.abs(requested-target)<.015||Math.abs(limit-target)<1e-8)return bounds.targetSeconds;
 const fraction=Math.min(1,Math.max(0,(requested-target)/(limit-target)));
 return Number((bounds.targetSeconds+fraction*(bounds[side]-bounds.targetSeconds)).toFixed(2));
}
function validateBudgets(rows,ledger,ids){
 const issues=[],budgets=[];
 if(!Array.isArray(rows))return {issues:['performanceBudgets is missing'],budgets};
 for(const id of ids){const matches=rows.filter(r=>r.shotId===id);if(matches.length!==1){issues.push(`${id}: expected exactly one physical performance budget`);continue;}
  const turns=ledger.filter(t=>t.sourceShotId===id);if(!turns.length&&matches[0].silent!==true)issues.push(`${id}: no source dialogue`);
  const budget={...evaluateBudget(matches[0],turns),...(matches[0].silent===true?{silent:true}:{})};budgets.push(budget);issues.push(...budget.issues.map(i=>`${id}: ${i}`));
 }
 if(rows.some(r=>!ids.includes(r.shotId)))issues.push('budget refers to an unknown production unit');
 return {issues,budgets};
}
const authorDirective=DIRECTIVE;
module.exports={VERSION,DIRECTIVE:authorDirective+require('./shot-performance-contract').DIRECTIVE,evaluateBudget,validateBudgets,preferredSpeechSeconds};
