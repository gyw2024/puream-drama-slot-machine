'use strict';
const crypto=require('node:crypto');
const clean=x=>String(x||'').trim().replace(/[。；;]+$/u,'');
const key=name=>'item_'+crypto.createHash('sha256').update(clean(name)).digest('hex').slice(0,16);
function production(project){return String(project.script?.formatAdaptation?.productionScript||project.script?.sourcePreparation?.parts?.map(p=>p.productionScript).join('\n')||'');}
function shotEvidence(project,shot){
 const own=[shot.action,shot.stateBefore,shot.stateAfter,shot.visualBeat,shot.dialogue].filter(Boolean).join('\n');
 const blocks=[...production(project).matchAll(/^###\s+(S\d+)\s*[｜|][\s\S]*?(?=^###\s+S\d+\s*[｜|]|$(?![\s\S]))/gm)];
 const matches=blocks.filter(m=>m[1]===shot.id);
 // A recycled numeric shot ID alone is not provenance. Require its full action
 // to occur in that source block before admitting headings/declared objects.
 const action=String(shot.action||'').trim();
 const block=matches.length===1&&action.length>=12&&matches[0][0].includes(action)?matches[0][0]:'';
 return [...new Set([own,block].filter(Boolean))].join('\n');
}
function catalog(project){
 const rows=[],seen=new Map();
 const add=(text,shotId)=>{text=String(text||'').trim();if(text.length<2)return;let row=seen.get(text);if(!row){row={id:'E'+String(rows.length+1).padStart(4,'0'),text,shotIds:[]};rows.push(row);seen.set(text,row);}if(shotId&&!row.shotIds.includes(shotId))row.shotIds.push(shotId);};
 for(const text of [project.script?.raw,production(project)])for(const line of String(text||'').split('\n'))add(line);
 for(const s of project.shots||[])for(const line of shotEvidence(project,s).split('\n'))add(line,s.id);
 return rows;
}
function bindIdentities(result,project){
 const previous=project.assetLibraries?.props||[],used=new Set();
 // Never trust generated existingId. Only an unambiguous exact identity name
 // can inherit an existing asset and its approved physical design.
 for(const asset of result.assets||[]){const matches=previous.filter(p=>clean(p.name)===clean(asset.name));const match=matches.length===1&&!used.has(matches[0].id)?matches[0]:null;asset.existingId=match?.id||'';if(match)used.add(match.id);}
 return result;
}
function compile(response,project,declarations){
 if(!Array.isArray(response?.objects))return bindIdentities(response,project);
 const evidence=new Map(catalog(project).map(r=>[r.id,r]));
 const assets=response.objects.map(o=>({key:key(o.name),name:clean(o.name),aliases:Array.isArray(o.aliases)?o.aliases:[],classification:o.role==='background'?'in_scene':o.role,description:o.description||'',reason:o.reason||'Source-bound physical identity',parentKey:o.parentName?key(o.parentName):'',sourceQuotes:(o.sourceEvidenceIds||[]).map(id=>evidence.get(id)?.text||`UNKNOWN EVIDENCE ${id}`),appearances:(o.occurrences||[]).map(p=>{const ref=evidence.get(p.evidenceId);return {shotId:p.shotId,visibility:p.visibility,evidence:ref?.shotIds.includes(p.shotId)?ref.text:'',evidenceId:p.evidenceId};})}));
 const names=new Map(assets.map(a=>[a.name,a.key]));
 const decisions=(response.coverage||[]).map(d=>({id:d.declarationId,classification:(d.assetNames||[]).length?'mapped':d.disposition,assetKeys:(d.assetNames||[]).map(n=>names.get(clean(n))||`UNKNOWN ASSET ${n}`),reason:d.reason||''}));
 return bindIdentities({assets,decisions,contractVersion:2,rawSemanticResponse:response},project);
}
const INSTRUCTION=require('./generation-prompts').build("inventory",'You interpret physical objects in a supplied story. The application owns asset IDs, evidence text and database references. Do not invent or return existingId, asset keys, copied evidence quotes or timestamps. Select supplied evidence IDs only. Return JSON {objects:[{name:"unique physical identity name",aliases:[],role:"core|background",description:"short physical identity",reason:"causal role",parentName:"optional exact name of another returned object",sourceEvidenceIds:["E0001"],occurrences:[{shotId:"S01",visibility:"visible|stored",evidenceId:"E0001"}]}],coverage:[{declarationId:"G001",assetNames:["exact returned object names"],disposition:"set_dressing|incidental|state_or_part|product",reason:"source-grounded disposition"}]}. Every supplied declaration must have one coverage entry. Use assetNames for represented objects; for exclusions use empty assetNames and an explicit disposition. Each occurrence evidence ID must list the selected shot in shotIds. A core object requires a visible occurrence. Characters merely discussing an absent object does not make it visible. Scene headings and declared core objects are valid shot context when supplied as evidence for that shot. Background furniture and vehicle interiors are background, not independently generated handheld props. Preserve distinct physical objects even when they share generic aliases. The exact locked sellable product is excluded as product; do not redesign it. Use exact established names for the same physical identity. No new story events or product claims. Different holders or wording do not create another physical object. Inventory the physical prerequisites of each source action before returning: brewing or pouring requires the source-implied liquid vessel and receiving container; handing over requires the actual transferred object. Cite the action evidence that entails the prerequisite. Register every visible manipulated non-product object as a core identity, including an implied pouring vessel, even if the author did not separately name it. Do not invent unrelated accessories. Changes from empty to filled or open to closed are states of one identity, never extra objects. Return the final JSON directly.');
module.exports={production,shotEvidence,catalog,compile,bindIdentities,INSTRUCTION};
