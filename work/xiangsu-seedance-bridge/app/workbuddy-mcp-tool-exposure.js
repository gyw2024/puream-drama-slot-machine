'use strict';
const fs=require('node:fs');
const names=['read_stage_task','preview_stage_result','submit_stage_result','stage_result_part','read_stage_file','write_stage_file'].map(n=>'mcp__puream_delivery__'+n);
const cache=new Map();
function supportsDirect(entry){
 try{const st=fs.statSync(entry),key=entry+':'+st.size+':'+st.mtimeMs;if(cache.has(key))return cache.get(key);
  const source=fs.readFileSync(entry,'utf8'),supported=source.includes('NoDefer(')&&source.includes('toolDeferOverlay');cache.set(key,supported);return supported;
 }catch{return false;}
}
function select(entry,baseInstruction){
 const direct=supportsDirect(entry);
 const exposure=direct?'Call the directly exposed mcp__puream_delivery__ tools with their own named arguments. Do not use ToolSearch or DeferExecuteTool when the required MCP tool is already exposed. If connecting, WaitForMcpServers and then use the exposed tool. No test writes: result files hold only the requested authored result.':'For deferred tools, DeferExecuteTool arguments have toolName at the TOP LEVEL, next to params: {"toolName":"exact discovered MCP name","params":{"field":"value"}}. Never put toolName inside params. No test writes.';
 return {mode:direct?'direct-mcp':'deferred-mcp',tools:direct?['WaitForMcpServers',...names.map(n=>'NoDefer('+n+')')].join(','):['ToolSearch','WaitForMcpServers','DeferExecuteTool',...names].join(','),instruction:baseInstruction+'\n'+exposure};
}
module.exports={names,supportsDirect,select};
