'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// Per-invocation overrides only: never rewrite the user's Codex configuration.
// Text production uses supplied text/images, not external MCP tools. Inheriting
// the workbench MCP here starts another Electron tree on every writing request.
function serverNames(text){
 const names=new Set();
 const token='(?:"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'|[A-Za-z0-9_-]+)';
 const pattern=new RegExp('^\\s*\\[\\s*mcp_servers\\s*\\.\\s*('+token+')(?:\\s*\\.[^\\]]+)?\\s*\\]\\s*(?:#.*)?$','gm');
 for(const m of String(text).matchAll(pattern)){
  let name=m[1];try{if(name.startsWith('"'))name=JSON.parse(name);else if(name.startsWith("'"))name=name.slice(1,-1);}catch{continue;}
  if(name&&!/[\r\n\0]/.test(name))names.add(name);
 }
 return [...names];
}
function overrides(cwd,env=process.env,home=os.homedir()){
 const files=new Set([path.join(env.CODEX_HOME||path.join(home,'.codex'),'config.toml')]);
 for(let dir=path.resolve(cwd);;){files.add(path.join(dir,'.codex','config.toml'));const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
 const names=new Set();for(const file of files){try{for(const name of serverNames(fs.readFileSync(file,'utf8')))names.add(name);}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}}
 // Codex -c splits a dotted key literally; quoted key fragments create a new
 // invalid server on older CLIs. Only override unambiguous bare server IDs.
 return ['-c','features.apps=false','-c','features.plugins=false',...[...names].filter(name=>/^[A-Za-z0-9_-]+$/.test(name)).flatMap(name=>['-c',`mcp_servers.${name}.enabled=false`])];
}
module.exports={serverNames,overrides};
