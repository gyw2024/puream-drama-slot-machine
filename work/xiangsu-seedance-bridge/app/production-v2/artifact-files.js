'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {fail,textHash}=require('./contracts');
async function saveFullText(root,body){
  if(typeof body!=='string')throw fail('ARTIFACT_TEXT_REQUIRED','Expected full text, never a preview');
  const dir=path.join(root,'text-artifacts');await fs.mkdir(dir,{recursive:true});
  const digest=textHash(body),dest=path.join(dir,`${digest}.txt`),temp=path.join(dir,`.${digest}.${crypto.randomUUID()}.tmp`);
  let handle;
  try{
    handle=await fs.open(temp,'wx');await handle.writeFile(body,'utf8');await handle.sync();await handle.close();handle=null;
    try{await fs.link(temp,dest);}catch(e){if(e.code!=='EEXIST')throw e;const prior=await fs.readFile(dest,'utf8');if(textHash(prior)!==digest)throw fail('ARTIFACT_HASH_CONFLICT',digest);}
  }finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
  return {artifactId:`text:${digest}`,sha256:digest,utf8Bytes:Buffer.byteLength(body,'utf8'),textCodeUnits:body.length,path:dest,preview:body.slice(0,2000),previewOnly:body.length>2000};
}
async function readUtf8Page(file,{offset=0,maxBytes=8192,expectedHash}){
  // The trusted artifact registry resolves file; no caller-provided arbitrary path.
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxBytes)||maxBytes<4||maxBytes>65536)throw fail('PAGE_RANGE_INVALID','Use a byte cursor');
  const h=await fs.open(file,'r');
  try{
    const stat=await h.stat();if(offset>stat.size)throw fail('PAGE_RANGE_INVALID','Offset past end');
    const b=Buffer.alloc(Math.min(maxBytes+4,stat.size-offset));await h.read(b,0,b.length,offset);
    if(b.length&&(b[0]&0xC0)===0x80)throw fail('UTF8_CURSOR_INVALID','Resume only from a returned cursor');
    let end=Math.min(maxBytes,b.length);while(end>0&&end<b.length&&(b[end]&0xC0)===0x80)end--;
    const content=b.subarray(0,end).toString('utf8');return {content,offset,nextOffset:offset+end,complete:offset+end===stat.size,totalBytes:stat.size,artifactHash:expectedHash};
  }finally{await h.close();}
}
module.exports={saveFullText,readUtf8Page};
