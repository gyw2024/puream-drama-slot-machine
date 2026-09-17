'use strict';
const cache = new Map();
function compare(a,b) {
  const parts=v=>{const m=String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:rc(\d+))?/i);return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:0,+(m[4]||0)]:[];};
  const x=parts(a),y=parts(b);
  for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return Math.sign(d);}
  return 0;
}
async function latest(id) {
  // Only these two have a queryable official distribution channel; every
  // other claimed client is verified locally only (T17).
  if(id!=='grokbuild'&&id!=='deepseek-harness')return null;
  const old=cache.get(id);if(old&&Date.now()-old.at<3600000)return old.value;
  const url=id==='grokbuild'?'https://x.ai/cli/stable':'https://pypi.org/pypi/deepseek-harness-sdk/json';
  try {
    const r=await fetch(url,{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP');
    const value=id==='grokbuild'?(await r.text()).trim():(await r.json()).info.version;
    if(!/^\d+\.\d+\.\d+(?:rc\d+)?$/.test(value))throw Error('version');
    cache.set(id,{at:Date.now(),value});return value;
  }catch{return null;}
}
const EVIDENCED_CLIENTS=['grokbuild','deepseek-harness','codex','antigravity','workbuddy'];
const OFFICIAL_CHANNEL=new Set(['grokbuild','deepseek-harness']);
module.exports=async function versionNote(id,exe,run,cwd) {
  // T17: every claimed client must produce version evidence. Clients with an
  // official distribution channel also get a remote comparison; the rest are
  // recorded as locally verified.
  if(!EVIDENCED_CLIENTS.includes(id))return '';
  try {
    const args=id==='deepseek-harness'
      ?['-c','import importlib.metadata; print(importlib.metadata.version("deepseek-harness-sdk"))']
      :['--version'];
    const [r,remote]=await Promise.all([run(exe,args,{cwd,timeoutMs:5000}),latest(id)]);
    const local=(r.output||'').match(/\d+\.\d+\.\d+(?:rc\d+)?/)?.[0];
    if(!local)return '；客户端版本未能核验';
    if(!remote)return `；客户端 ${local}；${OFFICIAL_CHANNEL.has(id)?'官方版本检查失败，不能确认最新':'本机核验'}`;
    return `；客户端 ${local}；`+(compare(local,remote)<0?`官方已有 ${remote}，请更新客户端后刷新模型`:`官方版本 ${remote}（已核验）`);
  }catch{return '；客户端版本检查失败，不能确认最新';}
};
module.exports.compare=compare;
