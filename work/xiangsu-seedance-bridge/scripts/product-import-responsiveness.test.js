"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../app/main.js"),"utf8");
const start=source.indexOf('ipcMain.handle("workbench:choose-product",');
const block=source.slice(start,source.indexOf('\nipcMain.handle(',start+1));
function handler(options={}) {
  let invoke,imports=0,uploads=0,replacements=0;
  const project={id:"project_test_12345678",product:{imagePath:"D:\\fixture\\product.png"}};
  vm.runInNewContext(block,{
    ipcMain:{handle:(_name,fn)=>{invoke=fn;}},mainWindow:null,
    dialog:{showOpenDialog:async()=>options.selection||{filePaths:["D:\\fixture\\selected.png"],canceled:false}},
    MEDIA_RULES:{image:{filters:[]}},
    importProductFromPath:async(id,file)=>{imports++;if(options.error)throw options.error;assert.equal(id,project.id);assert.equal(file,"D:\\fixture\\selected.png");return {asset:{path:project.product.imagePath},project};},
    requireWorkbench:()=>({store:{getSettings:()=>({videoProvider:{}}),replaceProductAsset:()=>{replacements++;return project;},addActivity:()=>{}},workflow:{resolveHttpsReferenceInputs:()=>{uploads++;return new Promise(()=>{});}}}),
    hasOssCredentials:()=>true,
    publicError:error=>({ok:false,code:error.code,message:error.message}),
    sanitizePublicMessage:s=>s
  });
  return {invoke:()=>invoke(null,project.id),counts:()=>({imports,uploads,replacements}),project};
}
test("a locally saved product returns without waiting for unavailable cloud storage",async()=>{
  const h=handler();let timer;
  try{const result=await Promise.race([h.invoke(),new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),80);})]);assert.equal(result.timedOut,undefined,"local preview is blocked on remote upload");assert.equal(result.ok,true);assert.equal(result.project.product.imagePath,h.project.product.imagePath);assert.deepEqual(h.counts(),{imports:1,uploads:0,replacements:0});}
  finally{clearTimeout(timer);}
});
test("cancelling the chooser preserves the current product without imports",async()=>{
  const h=handler({selection:{canceled:true,filePaths:[]}}),r=await h.invoke();assert.equal(r.canceled,true);assert.equal(r.ok,true);assert.equal(h.counts().imports,0);
});
test("local file errors return the public failure instead of claiming success",async()=>{
  const h=handler({error:Object.assign(new Error("图片无法解码"),{code:"IMAGE_DECODE_FAILED"})}),r=await h.invoke();assert.equal(r.ok,false);assert.equal(r.code,"IMAGE_DECODE_FAILED");assert.equal(h.counts().uploads,0);
});

const renderer=fs.readFileSync(path.join(__dirname,"../app/renderer/workbench.js"),"utf8");
const stateFunction=renderer.slice(renderer.indexOf('function renderProductImportState()'),renderer.indexOf('\nfunction renderScript()'));
const listener=renderer.slice(renderer.indexOf('$("#productImage").addEventListener("click",'),renderer.indexOf('$("#selectProductLibrary")?.addEventListener'));
function ui() {
  let click,resolve,reject,calls=0,renders=0;
  const label={textContent:""},button={disabled:false,attributes:{},setAttribute(k,v){this.attributes[k]=v;},querySelector:()=>label,addEventListener:(_event,fn)=>{click=fn;}},library={disabled:false},status={textContent:""};
  const elements={"#productImage":button,"#selectProductLibrary":library,"#productState":status};
  const original={id:"one",product:{imagePath:"old.png"}},state={project:original,productImportProjectId:""},toasts=[];
  const context=vm.createContext({state,$:selector=>elements[selector],api:{workbench:{chooseProduct:()=>{calls++;return new Promise((a,b)=>{resolve=a;reject=b;});}}},setStateProject:p=>{state.project=p;},renderAll:()=>{renders++;},showToast:(message,kind)=>toasts.push({message,kind})});
  vm.runInContext(stateFunction+listener,context);
  return {click:()=>click(),resolve:r=>resolve(r),reject:e=>reject(e),state,original,button,library,status,label,toasts,counts:()=>({calls,renders})};
}
test("pending import has immediate feedback and ignores duplicate clicks",async()=>{
  const h=ui(),pending=h.click();assert.equal(h.button.disabled,true);assert.equal(h.library.disabled,true);assert.equal(h.button.attributes["aria-busy"],"true");assert.match(h.status.textContent,/正在导入/);await h.click();assert.equal(h.counts().calls,1);
  h.resolve({ok:true,project:{id:"one",product:{imagePath:"new.png"}}});await pending;
  assert.equal(h.state.project.product.imagePath,"new.png");assert.equal(h.counts().renders,1);assert.equal(h.button.disabled,false);assert.equal(h.button.attributes["aria-busy"],"false");assert.equal(h.status.textContent,"已锁定商品图");assert.equal(h.toasts[0].kind,"success");
});
test("cancel keeps the previous image and restores the upload button",async()=>{
  const h=ui(),p=h.click();h.resolve({ok:true,canceled:true});await p;assert.equal(h.state.project,h.original);assert.equal(h.button.disabled,false);assert.equal(h.toasts.length,0);
});
test("rejected IPC and returned failures retain the image and allow retry",async()=>{
  for(const reject of [false,true]){const h=ui(),p=h.click();if(reject)h.reject(new Error("transport closed"));else h.resolve({ok:false,message:"图片不可读取"});await p;assert.equal(h.state.project,h.original);assert.equal(h.button.disabled,false);assert.equal(h.toasts[0].kind,"error");assert.equal(h.state.productImportProjectId,"");}
});
test("an import finishing after project switch cannot replace the selected project",async()=>{
  const h=ui(),p=h.click(),other={id:"two",product:{imagePath:"other.png"}};h.state.project=other;h.resolve({ok:true,project:{id:"one",product:{imagePath:"new.png"}}});await p;assert.equal(h.state.project,other);assert.equal(h.counts().renders,0);assert.match(h.toasts[0].message,/原项目/);assert.equal(h.button.disabled,false);
});
test("a mismatched result is rejected instead of replacing the project",async()=>{
  const h=ui(),p=h.click();h.resolve({ok:true,project:{id:"wrong",product:{imagePath:"wrong.png"}}});await p;assert.equal(h.state.project,h.original);assert.equal(h.toasts[0].kind,"error");assert.equal(h.counts().renders,0);
});
