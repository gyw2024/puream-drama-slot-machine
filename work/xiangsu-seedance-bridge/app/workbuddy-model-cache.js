'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
// WorkBuddy's desktop and bundled CLI keep separate versioned product caches.
// Read only compressed product catalogs; authentication entries are not parsed.
function read(home=process.env.USERPROFILE){
 const root=path.join(home||require('node:os').homedir(),'.workbuddy','local_storage');let files;try{files=fs.readdirSync(root);}catch{return [];}
 const rows=[];
 for(const file of files.filter(f=>/^(?:wb_)?entry_[a-f0-9]{32}\.info$/.test(f))){try{
  const full=path.join(root,file),stat=fs.statSync(full);if(stat.size>4*1024*1024)continue;
  const fd=fs.openSync(full,'r'),head=Buffer.alloc(8);try{fs.readSync(fd,head,0,8,0);}finally{fs.closeSync(fd);}if(!head.toString().startsWith('"H4sI'))continue;
  const encoded=JSON.parse(fs.readFileSync(full,'utf8'));const config=JSON.parse(zlib.gunzipSync(Buffer.from(encoded,'base64'),{maxOutputLength:24*1024*1024}).toString('utf8'));
  if(config.productName!=='WorkBuddy'||!Array.isArray(config.models)||!Array.isArray(config.agents))continue;
  const allowed=new Set(config.agents.filter(a=>a.tags?.includes('default')).flatMap(a=>a.models||[]));
  for(const model of config.models){if(typeof model.id!=='string'||model.disabled===true||!(allowed.has(model.id)||model.tags?.includes('chat')||model.id.startsWith('custom-local:')))continue;
   rows.push({id:model.id,label:String(model.name||model.id),efforts:[],tiers:[],catalogSource:'workbuddy-desktop-cache',catalogVersion:String(config.genieVersion||''),catalogUpdatedAt:stat.mtime.toISOString()});}
 }catch{/* An unreadable cache never erases an existing catalog. */}}
 rows.sort((a,b)=>b.catalogUpdatedAt.localeCompare(a.catalogUpdatedAt));return [...new Map(rows.reverse().map(r=>[r.id,r])).values()];
}
// Keep the native definition separate from custom aliases. The CLI can otherwise
// resolve a bare built-in ID to custom-local:<same ID> before the catalog is ready.
function readBuiltin(id,home=process.env.USERPROFILE){
 const root=path.join(home||require('node:os').homedir(),'.workbuddy','local_storage'),found=[];
 let files;try{files=fs.readdirSync(root);}catch{return null;}
 for(const file of files.filter(f=>/^(?:wb_)?entry_[a-f0-9]{32}\.info$/.test(f))){try{
  const full=path.join(root,file),stat=fs.statSync(full);if(stat.size>4*1024*1024)continue;
  const raw=fs.readFileSync(full,'utf8');if(!raw.startsWith('"H4sI'))continue;
  const config=JSON.parse(zlib.gunzipSync(Buffer.from(JSON.parse(raw),'base64'),{maxOutputLength:24*1024*1024}).toString('utf8'));
  if(config.productName!=='WorkBuddy'||!Array.isArray(config.models))continue;
  const model=config.models.find(m=>m.id===id&&!m.disabled&&!m.url&&!m.apiKey&&!m.tags?.includes('custom')&&!m.id.startsWith('custom'));
  if(model)found.push({model,version:String(config.genieVersion||''),updatedAt:stat.mtime.toISOString()});
 }catch{}}
 return found.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]||null;
}
module.exports={read,readBuiltin};
