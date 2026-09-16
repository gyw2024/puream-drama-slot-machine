'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {workbuddyLaunch}=require('../app/local-agent-runtime');
test('native model launch excludes same-name custom aliases without changing global configuration',()=>{
 const root=path.resolve(__dirname,'../../../.codex_tests/TASK-20260913-AGENT-296/builtin-routing-tests');fs.mkdirSync(root,{recursive:true});
 const dir=fs.mkdtempSync(path.join(root,'case-')),cli=path.join(dir,'resources/app.asar.unpacked/cli'),home=path.join(dir,'home'),local=path.join(home,'.workbuddy/local_storage');fs.mkdirSync(path.join(cli,'dist'),{recursive:true});fs.mkdirSync(local,{recursive:true});fs.writeFileSync(path.join(cli,'dist/codebuddy.js'),'fixture');
 const product={productName:'WorkBuddy',dataFolderName:'.workbuddy',genieVersion:'5.5.6',models:[{id:'other-native'}],agents:[{tags:['default'],models:['other-native']}],productFeatures:{CustomModelsJSON:true}};
 fs.writeFileSync(path.join(cli,'product.json'),JSON.stringify(product));
 const custom=[{id:'glm-5.3-flash',url:'https://custom.invalid'}];const customFile=path.join(home,'.workbuddy/models.json');fs.writeFileSync(customFile,JSON.stringify(custom));
 const cached={productName:'WorkBuddy',genieVersion:'5.2.6',models:[{id:'glm-5.3-flash',supportsToolCall:true},{id:'custom-local:glm-5.3-flash',aliases:['glm-5.3-flash'],tags:['custom'],url:'https://custom.invalid'}]};
 fs.writeFileSync(path.join(local,'entry_00000000000000000000000000000000.info'),JSON.stringify(zlib.gzipSync(JSON.stringify(cached)).toString('base64')));
 const prev=process.env.USERPROFILE;process.env.USERPROFILE=home;
 try{
  const exe=path.join(dir,'WorkBuddy.exe'),launch=workbuddyLaunch(exe,{model:'glm-5.3-flash',directory:path.join(dir,'job')});
  const effective=JSON.parse(fs.readFileSync(launch.env.ACC_PRODUCT_CONFIG_PATH));
  assert.equal(launch.env.CODEBUDDY_DISABLE_PRODUCT_CACHE,'1');assert.equal(effective.productFeatures.CustomModelsJSON,false);assert.equal(effective.models[0].id,'glm-5.3-flash');assert.equal(launch.modelSource.kind,'builtin');assert.equal(launch.modelSource.definitionVersion,'5.2.6');
  assert.deepEqual(JSON.parse(fs.readFileSync(customFile)),custom);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cli,'product.json'))),product);
  const explicitCustom=workbuddyLaunch(exe,{model:'custom-local:glm-5.3-flash',directory:path.join(dir,'custom-job')});assert.equal(explicitCustom.modelSource,null);assert.equal(explicitCustom.env.ACC_PRODUCT_CONFIG_PATH,path.join(cli,'product.json'));
 }finally{if(prev===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=prev;}
});
