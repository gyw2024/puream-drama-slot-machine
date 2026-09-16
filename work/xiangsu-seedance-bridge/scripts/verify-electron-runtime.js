'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const required=pkg.devDependencies.electron.replace(/^[~^]/,''),dir=path.join(root,'node_modules/electron/dist');
const actual=fs.readFileSync(path.join(dir,'version'),'utf8').trim();
if(actual!==required)throw Error(`Electron runtime mismatch: expected ${required}, received ${actual}`);
for(const f of ['electron.exe','resources.pak','icudtl.dat'])if(!fs.statSync(path.join(dir,f)).isFile())throw Error('Incomplete Electron runtime: '+f);
console.log(JSON.stringify({electronVersion:actual,source:'verified installed dependency',ready:true}));
