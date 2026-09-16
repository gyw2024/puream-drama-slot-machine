'use strict';

// Native T2VA / I2VA / FL2VA use the official three-field template. Transform
// only compiler-owned structure/bindings: the final acting timeline, dialogue
// multiplicity and times stay untouched, including on the edited/spec paths.
const text = value => String(value || '').trim();
const english = value => text(value) && !/[\u3400-\u9fff]/u.test(value) ? text(value) : '';
function appearance(value) {
  // Asset-only negative layout instructions are not physical appearance and
  // must not prime graphic concepts in a moving-image request. Do not remove
  // intrinsic positive printing/photo content or any acting/source sentence.
  return english(value).split(/(?<=[.!?])\s+/).filter(sentence => !(/\b(?:no|without|never)\b/i.test(sentence) && /\b(?:captions?|subtitles?|watermarks?)\b|on[- ]screen\s+text/i.test(sentence))).join(' ');
}
function identityAppearance(entity) {
  const cues=require('./native-identity-cues');
  if(cues.current(entity))return entity.nativeIdentityCue.text;
  // Legacy/manual preview only. Production authoring uses the source-hashed
  // cue stage; never paste a portrait's idle pose into the acting timeline.
  return appearance(entity?.descriptionEn).split(/(?<=[.!?])\s+/).filter(sentence=>!(/\b(?:stands?|sits?|arms?|hands?|lips?|expression|calm|relaxed)\b/i.test(sentence))).join(' ');
}
function outsideDialogue(source, transform) {
  return String(source).split(/(<d>[\s\S]*?<\/d>)/gi).map(part => /^<d>/i.test(part) ? part : transform(part)).join('');
}
function nativePrompt({prompt, project, shot, references, bindings}) {
  if (!['text_to_video','image_to_video'].includes(references.hailuoApiMode)) return prompt;
  const roles = references.imageRoles || [];
  const section = name => {
    const match = String(prompt).match(new RegExp('(?:^|\\n)'+name+':\\s*\\n([\\s\\S]*?)(?=\\n(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):|$)'));
    return match ? match[1].trim() : '';
  };
  let body = section('detailed_description') || section('integrated_multimodal_description');
  const replacements = new Map(), identities = [];
  const castIds = [...new Set([...(shot.visibleCharacterIds || shot.characterIds || []), ...(shot.dialogueTurns || []).map(t=>t.speakerId).filter(Boolean)])];
  for (const id of castIds) {
    const entity = (project.characters || []).find(c=>c.id===id) || {};
    const label = String(id);
    replacements.set(bindings.subjects.get(id) || bindings.backgroundAliasByCharacterId.get(id) || id, label);
    const gender = /^(?:female|woman|女)$/i.test(entity.gender) ? 'female' : /^(?:male|man|男)$/i.test(entity.gender) ? 'male' : '';
    const age = Number(entity.age)>0 ? `age ${Number(entity.age)}` : english(entity.ageBand);
    const turns=(shot.dialogueTurns||[]).filter(t=>t.speakerId===id);
    const unseen = entity.offscreenOnly===true || (turns.length>0 && turns.every(t=>require('./drama-staging-contract').isOffscreen(t,project)) && !(shot.visibleCharacterIds||[]).includes(id));
    const description = unseen ? [age,gender].filter(Boolean).join(', ') : identityAppearance(entity) || [age,gender].filter(Boolean).join(', ');
    identities.push(unseen ? `${label} is an unseen voice owner${description ? ` (${description})` : ''}, not a visible figure; no pictured person embodies or lip-syncs this voice.` : `${label}${description ? `: ${description}` : ': retain the exact authored physical identity'}${/[.!?]$/.test(description)?'':'.'}`);
  }
  // Background aliasing must not erase named silent participants in a native
  // frame. Their identity is encoded in the frames rather than separate photos.
  const bind = source => outsideDialogue(source, value => {
    for (const [from,to] of replacements) value=value.split(from).join(to);
    return value.replace(/<Picture (\d+)>/g, 'Picture $1');
  });
  body=bind(body);
  for (const prop of project.assetLibraries?.props || []) {
    const label=`prop ${prop.id}`;
    if (body.includes(label) && identityAppearance(prop)) identities.push(`${label}: ${identityAppearance(prop)}`);
  }
  for (const binding of require('./drama-staging-contract').activeWardrobeBindings(project,shot)) {
    const wardrobe=(project.assetLibraries?.wardrobes||[]).find(w=>w.id===binding.wardrobeId);
    const description=appearance(wardrobe?.descriptionEn)||english(wardrobe?.name);
    if (description) identities.push(`The current complete appearance for person ${binding.characterId} is ${description}. This current appearance replaces the base outfit and persists in both supplied temporal frames.`);
  }
  body=body.replace('[Shot 1]', '[Shot 1] Identity reference only: '+identities.join(' ')+' These identity cues never override the explicitly authored current wardrobe, removed clothing, posture or held objects in this shot. The opening state and its subsequent events are the clothing/state authority.');
  const cutCount = Math.max(1, ...[...body.matchAll(/\[Shot (\d+)\]/g)].map(m=>Number(m[1])));
  const duration=Math.max(10, Math.min(15, Number(shot.duration) || 12)).toFixed(2);
  const start=roles.findIndex(r=>r.type==='storyboard_start'),end=roles.findIndex(r=>r.type==='storyboard_end');
  const alignment=[];
  if(start>=0)alignment.push(`Picture ${start+1} (from Shot 1) aligns with the 0.00-second mark of the target video`);
  if(end>=0)alignment.push(`Picture ${end+1} (from Shot ${cutCount}) aligns with the ${duration}-second mark of the target video`);
  return [alignment.length ? 'How the reference pictures align with the target video — '+alignment.join('; ')+'.\n' : '',
    'integrated_multimodal_description:', body, '', 'overall_soundscape:',bind(section('overall_soundscape')),
    '', 'non_diegetic_music:', section('non_diegetic_music') || 'N/A'].filter((v,i)=>i!==0||v).join('\n').trim();
}
module.exports={nativePrompt};
