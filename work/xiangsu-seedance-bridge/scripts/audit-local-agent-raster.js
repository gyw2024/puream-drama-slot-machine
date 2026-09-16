"use strict";
// No windows, no model calls: exercise Electron's actual raster decoder.
const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.whenReady().then(async()=>{
  const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260905-DRAMA-LOCAL-AGENTS-176/raster');
  fs.mkdirSync(root,{recursive:true});
  const {safeRaster}=require('../app/local-agent-runtime');
  const valid=path.join(root,'fixture-not-ai-generated.png');
  fs.writeFileSync(valid,nativeImage.createFromBitmap(Buffer.alloc(256*256*4,255),{width:256,height:256}).toPNG());
  assert.equal(safeRaster(valid,root).file,valid);
  const malformed=path.join(root,'invalid.png');
  const head=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(head);head.writeUInt32BE(256,16);head.writeUInt32BE(256,20);fs.writeFileSync(malformed,head);
  assert.throws(()=>safeRaster(malformed,root),{code:'LOCAL_AGENT_IMAGE_INVALID'});
  const report={ok:true,realElectronDecode:true,validRasterAccepted:true,headerOnlyFakeRejected:true,imageGenerationCalls:0,nativeWindowsCreated:0};
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
