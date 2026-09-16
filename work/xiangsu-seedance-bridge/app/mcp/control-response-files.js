'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const INLINE_BYTES=1024*1024;
function responsePath(connectionFile,instanceId,requestId){
 if(![instanceId,requestId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]+$/.test(v)))throw Error('Invalid local response identity');
 return path.join(path.dirname(path.resolve(connectionFile)),'mcp-control-responses',instanceId,requestId+'.json');
}
async function write(file,text){
 const bytes=Buffer.from(text,'utf8');
 await fs.promises.mkdir(path.dirname(file),{recursive:true});
 await fs.promises.writeFile(file,bytes,{flag:'wx',mode:0o600});
 return {bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
async function read(file,receipt){
 if(!Number.isSafeInteger(receipt?.bytes)||receipt.bytes<0||!/^[a-f0-9]{64}$/.test(receipt?.sha256||''))throw Error('Invalid local response receipt');
 const stat=await fs.promises.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==receipt.bytes)throw Error('Local response file does not match its receipt');
 const bytes=await fs.promises.readFile(file);
 if(bytes.length!==receipt.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==receipt.sha256)throw Error('Local response integrity mismatch');
 return JSON.parse(bytes.toString('utf8'));
}
module.exports={INLINE_BYTES,responsePath,write,read};
