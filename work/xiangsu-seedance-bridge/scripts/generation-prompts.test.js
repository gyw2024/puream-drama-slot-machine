'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const generation=require('../app/generation-prompts'),factory=require('../app/generation-template-defaults'),catalog=require('../app/generation-prompt-catalog.json');
test('every generation default resolves from the same catalog; fallbacks retain no old factory policy',()=>{
 const defaults=require('../app/prompt-library').defaultPromptTemplates(),g=factory.defaults(),canonical=require('../app/canonical-prompt-defaults.json').templates;
 assert.equal(Object.keys(defaults).length,68);assert.equal(Object.keys(g).length,61);
 for(const [key,value]of Object.entries(g)){assert.equal(defaults[key],value,key);assert.equal(canonical[key],value,key);assert.ok(value.trim(),key);}
 for(const fallback of [require('../app/docx-prompt-fusion').defaultDocxPromptFusionTemplates(),require('../app/reference-parity-prompts').defaultReferenceParityTemplates()])for(const [key,value]of Object.entries(fallback))if(Object.hasOwn(g,key))assert.equal(value,g[key],key);
 for(const stage of generation.stages){for(const rule of catalog.stages[stage].rules)assert.ok(catalog.rules[rule],stage+':'+rule);assert.equal(new Set(catalog.stages[stage].rules).size,catalog.stages[stage].rules.length);}
 for(const key of ['characterIntro','sceneAsset','propAsset','storyboardStart','storyboardSheet','hailuoCharacterVideo']){assert.doesNotMatch(g[key],/GENERATION METHOD|Return JSON|返回.*JSON|全片.*分钟/);}
 assert.match(g.scriptUnitGeneration,/productionShotSchema/);assert.match(g.scriptRepair,/shots/);assert.match(g.dialogueRewrite,/sourceId/);
});
test('settings migration upgrades exact old factories and preserves explicitly selected custom text across reload',()=>{
 const {WorkbenchStore}=require('../app/workbench-store');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'puream-generation-defaults-'));
 try{const store=new WorkbenchStore(dir);let settings=store.getSettings();const old=require('../app/canonical-prompt-defaults.json').templates.scriptSemanticReview;
  settings.prompts.topicIdeation='用户自定义选题：只写山村家庭';settings.promptModes.topicIdeation='custom';
  settings.prompts.scriptStoryBible='过期内置内容';settings.promptModes.scriptStoryBible='system';
  settings.prompts.scriptSemanticReview=old;settings.promptModes.scriptSemanticReview='custom';store.saveSettings(settings);
  const next=new WorkbenchStore(dir).getSettings();assert.equal(next.prompts.topicIdeation,settings.prompts.topicIdeation);assert.equal(next.promptModes.topicIdeation,'custom');assert.equal(next.prompts.scriptStoryBible,factory.defaults().scriptStoryBible);assert.equal(next.prompts.scriptSemanticReview,old);assert.equal(next.promptModes.scriptSemanticReview,'custom');
 }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
});
test('generated source and sparse repair previews never invent source adjacency or semantic approval',()=>{
 const workspace=require('../app/authoring-workspace');const a={id:'S01',duration:10,dialogue:[{id:'D1',speakerId:'C1',text:'留下来陪我吧。'}]},b={id:'S99',duration:10,dialogue:[{id:'D99',speakerId:'C2',text:'我答应你。'}]};
 const state={fields:{shots:{1:[a],2:[b]}}};const sparse=workspace.staged({deliveryPreview:{kind:'screenplay-repair'}},state,'shots',[b]);assert.equal(sparse.shots[0].previous,null);assert.equal(sparse.shots[0].next,null);assert.match(sparse.neighborContext,/Sparse/);assert.equal(sparse.approved,undefined);
 const writing=workspace.staged({deliveryPreview:{kind:'screenplay-writing'}},state,'shots',[b]);assert.equal(writing.shots[0].previous.shotId,'S01');assert.equal(writing.shots[0].current.shotId,'S99');
});
test('script generation, directing and still image instructions keep their distinct output contracts',()=>{
 const writer=require('../app/compact-screenplay'),director=require('../app/agent-production-decisions'),stills=require('../app/storyboard-still-author'),editor=require('../app/h3-final-prompt-editor');
 assert.ok(writer.RULES.startsWith(generation.build('screenplay')));assert.ok(writer.DIRECTOR_INSTRUCTION.startsWith(generation.build('director')));
 assert.ok(stills.INSTRUCTION.startsWith(generation.build('stills')));assert.ok(editor.INSTRUCTION.startsWith(generation.build('video_editor')));
 assert.ok(require('../app/agent-decision-patch').INSTRUCTION.startsWith(generation.build('director_patch')));
 assert.ok(require('../app/inventory-evidence-contract').INSTRUCTION.startsWith(generation.build('inventory')));
 assert.equal(editor.INSTRUCTION.split('HAILUO OFFICIAL PROMPT AUTHORITY').length-1,1);
 const legacy=require('../app/workbench-workflow');for(const mode of ['asset_direct','keyframe','storyboard_sheet']){const s=legacy.productionUnitGenerationModeDirective(mode);assert.doesNotMatch(s,/最多2句|最多两名|必须在主反转完成后|用2–4个|必须切换机位/);assert.match(s,/完整/);}
 assert.doesNotMatch(legacy.compileTopicIdeationPrompt('卡片schema'),/3000|36|必须由两个/);
});
