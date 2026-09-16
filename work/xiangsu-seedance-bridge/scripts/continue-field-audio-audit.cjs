const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {app,safeStorage,net}=require('electron');
const live='C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge';
const out=path.resolve(__dirname,'../.codex_tests/TASK-20260905-PERFORMANCE-TIMELINE/continuation-audit');
app.setName('xiangsu-seedance-bridge');app.setPath('userData',path.join(out,'audit-runtime'));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const diff=(a,b,p='')=>{if(JSON.stringify(a)===JSON.stringify(b))return [];if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>diff(a[k],b[k],p?p+'.'+k:k));return [p]};
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const dec=s=>typeof s==='string'&&/^(enc:|safe:)/.test(s)?safeStorage.decryptString(Buffer.from(s.slice(s.indexOf(':')+1),'base64')):typeof s==='string'&&s.startsWith('b64:')?Buffer.from(s.slice(4),'base64').toString():s;
 const old=read(live+'/drama-license.json.bak'),now=read(live+'/drama-license.json');
 const report={createdAt:new Date().toISOString(),license:{rawChangedFields:diff(old,now),oldCopySha256:hash(fs.readFileSync(live+'/drama-license.json.bak')),decryptedTokenUnchanged:dec(old.tokenEnc)===dec(now.tokenEnc),decryptedActivationCodeUnchanged:dec(old.activationCodeEnc)===dec(now.activationCodeEnc),timestampChanges:{activatedAt:{before:old.activatedAt,after:now.activatedAt},lastHeartbeatOkAt:{before:old.lastHeartbeatOkAt,after:now.lastHeartbeatOkAt}}},settings:[],database:[]};
 const decryptTree=x=>typeof x==='string'?dec(x):Array.isArray(x)?x.map(decryptTree):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,decryptTree(v)])):x;
 for(const mode of ['workbench','workbench/simple-mode']){
  const s=read(live+'/'+mode+'/settings.json'),b=read(live+'/'+mode+'/settings.json.bak');
  report.settings.push({mode,currentBackupPlaintextChangedFields:diff(decryptTree(b),decryptTree(s)),settingsVersion:s.settingsVersion,promptLibraryVersion:s.promptLibraryVersion,note:'Backup is already post-install. This is NOT a before/after field proof.'});
  const dir=path.join(out,mode);fs.mkdirSync(dir,{recursive:true});
  for(const name of ['foundry-v2.sqlite','foundry-v2.sqlite-wal','foundry-v2.sqlite-shm'])fs.copyFileSync(live+'/'+mode+'/'+name,path.join(dir,name));
  const wal=fs.readFileSync(path.join(dir,'foundry-v2.sqlite-wal'));
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(dir,'foundry-v2.sqlite'),{readOnly:true});
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  const tableSummary=tables.map(t=>({table:t,count:db.prepare('SELECT COUNT(*) AS n FROM "'+t+'"').get().n}));
  const meta=db.prepare('SELECT key,updated_at FROM foundry_meta').all();
  report.database.push({mode,quickCheck:db.prepare('PRAGMA quick_check').all(),tableSummary,meta,walLength:wal.length,prefix41232Hash:hash(wal.subarray(0,41232))});db.close();
 }
 fs.writeFileSync(path.join(out,'field-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 const settings=decryptTree(read(live+'/workbench/settings.json'));const p=settings.textProviderProfiles['gemini-native'];
 const base=p.baseUrl.replace(/\/$/,'').replace(/\/models$/,'');
 const endpoint=base.includes('/v1')?base:base+'/v1beta';
 try{
  const r=await net.fetch(endpoint+'/models?pageSize=1000',{headers:{'x-goog-api-key':p.apiKey},signal:AbortSignal.timeout(18000)});const j=await r.json();
  const status={status:r.status,configuredModel:p.model,models:(j.models||[]).map(m=>({name:m.name,methods:m.supportedGenerationMethods})),error:r.ok?undefined:j.error?.message};
  fs.writeFileSync(path.join(out,'audio-provider-check.json'),JSON.stringify(status,null,2));console.log(JSON.stringify(status));
 }catch(e){console.log('AUDIO_PROVIDER_UNAVAILABLE '+e.message);fs.writeFileSync(path.join(out,'audio-provider-check.json'),JSON.stringify({error:e.message}));}
 app.quit();
}).catch(e=>{console.error(e.stack);app.exit(1)});
