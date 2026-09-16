'use strict';
const fs=require('node:fs'),path=require('node:path');
// Native Windows process creation has a small command-line limit. Large
// schemas belong in a file, not argv. Restore argv INSIDE the already-started
// Node host so the official CLI receives its complete, unchanged contract.
const bootstrap=`'use strict';
const fs=require('node:fs'),path=require('node:path');
const args=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!Array.isArray(args)||!args.length||args.some(v=>typeof v!=='string')||!path.isAbsolute(args[0]))throw Error('Invalid native CLI argument manifest');
process.argv=[process.execPath,...args];
require('node:module').runMain(args[0]);
`;
function prepare(directory,args){
 if(!Array.isArray(args)||!args.length||args.some(v=>typeof v!=='string')||!path.isAbsolute(args[0]))throw Error('Invalid native CLI launch arguments');
 fs.mkdirSync(directory,{recursive:true});
 const manifest=path.join(directory,'native-cli-argv.json'),entry=path.join(directory,'native-cli-entry.cjs');
 fs.writeFileSync(manifest,JSON.stringify(args),{encoding:'utf8',mode:0o600});
 fs.writeFileSync(entry,bootstrap,{encoding:'utf8',mode:0o600});
 return [entry,manifest];
}
module.exports={prepare};
