'use strict';
// Application files are the maintained source. The installed Skill receives
// generated, hash-checked copies; it is never a second editing location.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
function synchronize({destination,write=false,backup}={}){
 const target=destination||process.env.PUREAM_DRAMA_SKILL_DIR||path.join(process.env.CODEX_HOME||path.join(process.env.USERPROFILE||'',' .codex'.trim()),'skills/puream-drama-production-package/scripts');
 if(!fs.existsSync(path.join(target,'build-package.js')))throw Error('Drama package Skill not found: '+target);
 const manifestPath=path.join(target,'generated-runtime-manifest.json');
 const previous=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')).files.map(x=>x.path):[];
 const seeds=[...new Set([...previous,...fs.readdirSync(target).filter(n=>/\.(?:js|json)$/.test(n)&&fs.existsSync(path.join(root,'app',n))),'reference-rule-compaction.js'])];
 const files=new Set(seeds),queue=[...seeds];
 // Include the shared helpers' dependencies. workbench-workflow is the app
 // orchestration boundary, loaded only by app authoring paths, not packaging.
 while(queue.length){const name=queue.shift(),file=path.join(root,'app',name);if(!name.endsWith('.js'))continue;for(const m of fs.readFileSync(file,'utf8').matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)){let next=path.normalize(path.join(path.dirname(name),m[1]));if(!path.extname(next))next+='.js';if(next==='workbench-workflow.js'||!fs.existsSync(path.join(root,'app',next))||files.has(next))continue;if(next.startsWith('..'))throw Error('Dependency escapes app');files.add(next);queue.push(next);}}
 const report={version:require('../package.json').version,files:[],mismatches:[]};
 for(const name of [...files].sort()){const data=fs.readFileSync(path.join(root,'app',name)),file=path.join(target,name),equal=fs.existsSync(file)&&fs.readFileSync(file).equals(data);if(!equal){report.mismatches.push(name);if(write){if(backup&&fs.existsSync(file)){const b=path.join(backup,name);fs.mkdirSync(path.dirname(b),{recursive:true});if(!fs.existsSync(b))fs.copyFileSync(file,b);}fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}}report.files.push({path:name,sha256:crypto.createHash('sha256').update(data).digest('hex')});}
 const documents={
  'SKILL.md':fs.readFileSync(path.join(root,'app/skills/puream-drama-production-package/SKILL.md')),
  'references/prompt-review-standard.md':fs.readFileSync(path.join(root,'app/skills/puream-drama-production-package/references/prompt-review-standard.md')),
  'references/unified-audit-policy.md':Buffer.from('# 用户于2026-09-15确认的统一口径\n\n'+require('../app/unified-audit-policy').INSTRUCTION+'\n')
 };
 for(const [name,data] of Object.entries(documents)){const file=path.join(target,'..',name);if(!fs.existsSync(file)||!fs.readFileSync(file).equals(data)){report.mismatches.push('skill:'+name);if(write){if(backup&&fs.existsSync(file)){const b=path.join(backup,'skill-documents',name);fs.mkdirSync(path.dirname(b),{recursive:true});if(!fs.existsSync(b))fs.copyFileSync(file,b);}fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}}}
 if(write)fs.writeFileSync(manifestPath,JSON.stringify({version:report.version,source:'canonical drama application app directory',files:report.files},null,2));
 if(!write&&report.mismatches.length)throw Error('Skill runtime differs from application; run sync:drama-skill: '+report.mismatches.join(', '));
 return {version:report.version,files:report.files.length,updated:write?report.mismatches:[]};
}
if(require.main===module){const arg=k=>process.argv.find(s=>s.startsWith(k+'='))?.slice(k.length+1);console.log(JSON.stringify(synchronize({destination:arg('--destination'),write:process.argv.includes('--write'),backup:arg('--backup')})));}
module.exports={synchronize};
