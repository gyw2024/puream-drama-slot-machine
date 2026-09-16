'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const exposure=require('../app/workbuddy-mcp-tool-exposure');
test('selected CLI capability changes tool exposure without adding unrelated tools',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'puream-tool-exposure-')),entry=path.join(root,'cli.js');
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(entry,'legacy CLI');let value=exposure.select(entry,'scoped delivery');assert.equal(value.mode,'deferred-mcp');assert.ok(!value.tools.includes('NoDefer('));
 fs.writeFileSync(entry,'parser accepts NoDefer(tool) and applies toolDeferOverlay');value=exposure.select(entry,'scoped delivery');assert.equal(value.mode,'direct-mcp');assert.deepEqual(value.tools.split(','),['WaitForMcpServers',...exposure.names.map(n=>'NoDefer('+n+')')]);assert.ok(!value.tools.includes('DeferExecuteTool'));assert.ok(!value.tools.includes('ToolSearch'));
 const unavailable=exposure.select(path.join(root,'missing.js'),'scoped delivery');assert.equal(unavailable.mode,'deferred-mcp');
});
