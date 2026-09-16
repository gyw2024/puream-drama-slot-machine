const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {groups}=require('../app/source-dialogue-groups'),{catalog}=require('../app/indexed-production-plan'),{evaluateBudget}=require('../app/source-performance-budget');
test('explicit physical scene identity survives staging while real scene transitions remain distinct',()=>{
 const {applyDeclaredScene}=require('../app/whole-script-preparation');
 assert.deepEqual(applyDeclaredScene('人物：甲。场景：家中餐桌。商品：茶。',[{sourceSceneName:''},{sourceSceneName:'厨房'}]).map(x=>x.sourceSceneName),['家中餐桌','厨房']);
 assert.equal(applyDeclaredScene('场景：客厅。\n场景：厨房。',[{sourceSceneName:''}])[0].sourceSceneName,'');
});
test('planning schema does not promote a preferred silence estimate to a hard provider limit',()=>{
 const turns=[{id:'a',speaker:'甲',text:'今天回家了。',sourceShotId:'S01'},{id:'b',speaker:'乙',text:'等你一起喝。',sourceShotId:'S01'}];
 const group=groups(catalog(turns))[0],max=group.performanceLimits.maxInteriorSeconds;
 const phases=n=>[{phase:'before',seconds:2,action:'看向对方',reason:'原稿动作'},{phase:'during',seconds:n,action:'递茶',reason:'边说边递'},{phase:'after',seconds:2,action:'放下杯子',reason:'原稿动作'}];
 assert.ok(!evaluateBudget({actionPhases:phases(max)},turns).issues.some(x=>x.includes('interior actions')));
 assert.ok(evaluateBudget({actionPhases:phases(max+.1)},turns).advisories.some(x=>x.includes('interior actions')));
 const schema=require('../app/whole-output-contract').schema([group]);
 assert.equal(schema.properties.shotDetails.properties.S01.properties.budget.properties.duringSeconds.maximum,15);
});
test('text isolation disables inherited app/plugin startup only per invocation and leaves config untouched',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'text-isolation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.toml'),content='[mcp_servers.example]\ncommand="example"\n';fs.writeFileSync(file,content);
 const args=require('../app/codex-text-isolation').overrides(dir,{CODEX_HOME:dir},dir);
 for(const value of ['features.apps=false','features.plugins=false','mcp_servers.example.enabled=false'])assert.ok(args.includes(value));
 assert.equal(fs.readFileSync(file,'utf8'),content);
});
