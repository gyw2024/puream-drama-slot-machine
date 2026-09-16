'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {naturalDialogueOwnership:check}=require('../app/h3-natural-dialogue-ownership');
const lock="On-screen dialogue synchronizes only its named speaker's lips; off-screen dialogue leaves every visible mouth closed.";
const turn={speakerId:'C01',text:'今天辛苦你多帮衬。',onScreen:true};
const prefix='subject_definitions:\n<Subject 1> (S1) is the recurring character C01; exact identity.\n<Subject 2> is the recurring character C03; exact identity.\nsummary:\nVisit.\ndetailed_description:\n'+lock+'\n';
const line='<Subject 1> (S1) faces <Subject 2> and says exactly once: <d>[Chinese] 今天辛苦你多帮衬。</d>.';
test('compact final editorial grammar validates exact recurring identity without obsolete lips slogan',()=>assert.equal(check(prefix+line,turn,0,1),true));
test('rejects swapped subject despite correct speaker number',()=>assert.equal(check(prefix+line.replace('<Subject 1> (S1)','<Subject 2> (S1)'),turn,0,1),false));
test('rejects wrong identity in definition',()=>assert.equal(check(prefix.replace('character C01','character C02')+line,turn,0,1),false));
test('rejects missing mouth policy, duplicate identity definition, wrong words and wrong ordinal',()=>{
 assert.equal(check(prefix.replace(lock,'')+line,turn,0,1),false);
 assert.equal(check(prefix.replace('summary:','<Subject 1> (S1) is the recurring character C03; duplicate.\nsummary:')+line,turn,0,1),false);
 assert.equal(check(prefix+line,{...turn,text:'另一句。'},0,1),false);
 assert.equal(check(prefix+line,turn,0,2),false);
});
test('offscreen requires actual offscreen vocal action and never passes on-screen wording',()=>{
 const t={...turn,onScreen:false};
 assert.equal(check(prefix+line,t,0,1),false);
 const p=prefix.replace('character C01; exact identity.','character C01.')+line.replace('faces <Subject 2> and says exactly once','remains off-screen and says in an off-screen voiceover');
 assert.equal(check(p,t,0,1),true);assert.equal(check(p,turn,0,1),false);
});
test('reciprocal listener facing is not attributed to the speaker, but a real wrong addressee fails',()=>{
 const {stagingContractFailures}=require('../app/drama-staging-contract');
 const p={characters:[{id:'C01'},{id:'C02'},{id:'C03'}]};
 const t={speakerId:'C01',text:'你好。',listenerIds:['C03'],primaryListenerId:'C03',speakerFacingEn:"C01's eyes point left toward C03; C03 faces right toward C01."};
 assert.equal(stagingContractFailures(p,{dialogueTurns:[t]}).some(x=>x.startsWith('FACING_TARGET_CONFLICT')),false);
 assert.equal(stagingContractFailures(p,{dialogueTurns:[{...t,speakerFacingEn:'C01 faces C02; C03 faces C01.'}]}).some(x=>x.startsWith('FACING_TARGET_CONFLICT')),true);
});
test('finds current line owner after previous speech rather than first paragraph speaker',()=>{
 const p=prefix+line+' <Subject 2> (S2) faces <Subject 1> and says exactly once: <d>[Chinese] 我会的。</d>.';
 assert.equal(check(p,{speakerId:'C03',text:'我会的。',onScreen:true},1,2),true);
 assert.equal(check(p,{speakerId:'C01',text:'我会的。',onScreen:true},1,2),false);
});
