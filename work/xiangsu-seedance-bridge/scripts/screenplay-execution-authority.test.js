const test=require('node:test'),assert=require('node:assert/strict');
const {render}=require('../app/screenplay-execution-authority');
test('formal screenplay retains agent-authored identity, geography and final state without repeating speech',()=>{
 const line='陈岩（对母亲；温柔；双手空置）：我回来了。';
 const text=render({plan:{title:'回家',cast:[{name:'陈岩',role:'儿子',appearance:'灰色衬衫'}],locations:[{name:'餐厅',layout:'北窗，门在西侧'}]},parts:[{sceneLocation:'餐厅',scriptText:line,endState:'陈岩坐左侧，母亲坐右侧；茶罐留在桌面'}]});
 for(const expected of ['灰色衬衫','北窗，门在西侧','场末状态记录，非新增动作','茶罐留在桌面'])assert.ok(text.includes(expected));
 assert.equal(text.split('我回来了。').length-1,1);
});
