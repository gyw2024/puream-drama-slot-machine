'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderPart}=require('../app/screenplay-lines');
test('named self-addressed monologue survives screenplay rendering unchanged',()=>{
 const line={kind:'dialogue',speaker:'周师傅',listener:'周师傅',delivery:'低声自责',action:'站在工作台前翻开登记页',text:'她替这些伞挡了一场雨，我不能只说一句谢谢。'};
 const part=renderPart({sceneId:'S04',lines:[line],endState:'登记簿放在桌上'},[{name:'周师傅'}]);
 assert.deepEqual(part.lines,[line]);assert.equal(part.scriptText,'周师傅（对周师傅；低声自责；站在工作台前翻开登记页）：她替这些伞挡了一场雨，我不能只说一句谢谢。');
});
test('contextual addressees are semantic input while empty speaker fields remain structurally invalid',()=>{
 const line={kind:'dialogue',speaker:'周师傅',listener:'自己',delivery:'沉稳自勉',action:'放下笔',text:'我会把这件事做完。'};
 for(const listener of ['自己','观众','周师傅','众人','围桌的街坊','电话那头的老师'])assert.ok(renderPart({lines:[{...line,listener}]},[{name:'周师傅'}]).scriptText.includes(line.text));
 assert.throws(()=>renderPart({lines:[{...line,speaker:''}]},[{name:'周师傅'}]),{code:'SCRIPT_FIRST_PASS_INCOMPLETE'});
});
test('display wrapping does not discard a complete utterance or change raw authoring data',()=>{const line={kind:'dialogue',speaker:'周师傅',listener:'众人',delivery:'坚定',action:'放下笔',text:'我会把这件事做完。\n你们放心。'};const p=renderPart({lines:[line]},[]);assert.ok(p.scriptText.endsWith('我会把这件事做完。 你们放心。'));assert.equal(p.lines[0].text,line.text);});
