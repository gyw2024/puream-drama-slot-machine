'use strict';
// Authoring instructions only. No user-text rewriting, semantic gate or model call.
const catalog=require('./generation-prompt-catalog.json');
const VERSION=catalog.version;
function rule(id){
 const body=catalog.rules[id];
 if(id!=='commerce')return body;
 const ratio=require('./commerce-target-policy').DEFAULT_TARGET;
 return body+` 当前统一参考下限为${(ratio*100).toFixed(1)}%（来自已有参考剧本对白估算，非实测成片时长）；用户明确提供的其它目标优先，不能因示例较长自动提高目标。`;
}
function build(stage,technical=''){
 const entry=catalog.stages[stage];
 if(!entry)throw new TypeError('Unknown generation instruction stage: '+stage);
 const blocks=[`GENERATION METHOD ${VERSION} / ${stage}`,entry.method,...entry.rules.map(rule),technical];
 return blocks.filter(Boolean).join('\n\n');
}
function method(stage){return catalog.stages[stage]?.method||'';}
module.exports={VERSION,build,method,rule,stages:Object.freeze(Object.keys(catalog.stages))};
