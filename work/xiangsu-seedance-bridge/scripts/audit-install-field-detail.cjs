const fs=require('fs'),path=require('path'),crypto=require('crypto');const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'../.codex_tests/TASK-20260905-PERFORMANCE-TIMELINE');const out=path.join(root,'continuation-audit');
const src=path.join(out,'workbench/simple-mode');const dst=path.join(out,'simple-mode-before-reconstructed');fs.mkdirSync(dst,{recursive:true});
fs.copyFileSync(path.join(src,'foundry-v2.sqlite'),path.join(dst,'foundry-v2.sqlite'));const wal=fs.readFileSync(path.join(src,'foundry-v2.sqlite-wal')).subarray(0,41232);
const hash=crypto.createHash('sha256').update(wal).digest('hex');if(hash!=='8de917ae312174ad5e53ae6658206814df715f65fe30bc8f9e3cad5e9d429966')throw Error('Old WAL prefix hash mismatch');
fs.writeFileSync(path.join(dst,'foundry-v2.sqlite-wal'),wal);
const a=new DatabaseSync(path.join(dst,'foundry-v2.sqlite'),{readOnly:true}),b=new DatabaseSync(path.join(src,'foundry-v2.sqlite'),{readOnly:true});const changes=[];
for(const {name} of a.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){
 const x=a.prepare('SELECT * FROM "'+name+'"').all(),y=b.prepare('SELECT * FROM "'+name+'"').all();if(JSON.stringify(x)!==JSON.stringify(y))changes.push({table:name,before:x,after:y});
}a.close();b.close();
const report={simpleModeRecoveredOldWalExactHash:hash,changes};fs.writeFileSync(path.join(out,'sqlite-reconstructed-diff.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
