const test=require('node:test'),assert=require('node:assert/strict'),a=require('../app/script-adaptation');
const rows=[{id:'P00001',text:'张明：我每天送件，也该带个杯子。安心杯500毫升，39元。'}];
const contract={replacements:[{kind:'name',from:'张明',to:'李程'}],productLocks:[{kind:'name',quote:'安心杯'},{kind:'spec',quote:'500毫升'},{kind:'price',quote:'39元'},{kind:'claim',quote:'我每天送件，也该带个杯子。'}]};
const draft=[{id:'P00001',text:'李程：我每天送单，也该带个杯子。安心杯500毫升，39元。'}];
test('occupation wording is not a literal product fact; product evidence is mandatory',()=>{
 assert.equal(a.deterministicAudit(contract,rows,draft).ok,true);
 assert.throws(()=>a.reviewProductMeaning({ok:true,issues:[]},contract,rows),{code:'SCRIPT_ADAPTATION_REVIEW_INCOMPLETE'});
 const reviewed=a.reviewProductMeaning({ok:true,issues:[],productChecks:[{id:'PRODUCT_3',ok:true,evidence:'P00001 原稿送件改为送单，均需随身携杯，未改变商品宣称。'}]},contract,rows);
 assert.equal(reviewed.ok,true);
});
test('price corruption and semantic loss still fail independently',()=>{
 assert.equal(a.deterministicAudit(contract,rows,[{...draft[0],text:draft[0].text.replace('39元','9元')}]).ok,false);
 const reviewed=a.reviewProductMeaning({ok:true,issues:[],productChecks:[{id:'PRODUCT_3',ok:false,evidence:'P00001 改稿丢失携杯需求。'}]},contract,rows);
 assert.equal(reviewed.ok,false);assert.equal(reviewed.issues[0].type,'product_meaning');
});
test('a source actor inside a misclassified product spec requires semantic evidence instead of retaining the old name',()=>{
 const src=[{id:'P00001',text:'周梅用温水冲泡菊花茶，500毫升，39元。'}],c={productName:'菊花茶',replacements:[{kind:'name',from:'周梅',to:'许兰'}],productLocks:[{kind:'name',quote:'菊花茶'},{kind:'spec',quote:'周梅用温水冲泡菊花茶，500毫升，39元'}]},out=[{id:'P00001',text:'许兰用温水冲泡菊花茶，500毫升，39元。'}];
 assert.equal(a.deterministicAudit(c,src,out).ok,true);
 assert.throws(()=>a.reviewProductMeaning({ok:true,issues:[],productChecks:[]},c,src),{code:'SCRIPT_ADAPTATION_REVIEW_INCOMPLETE'});
 assert.equal(a.reviewProductMeaning({ok:true,issues:[],productChecks:[{id:'PRODUCT_1',ok:true,evidence:'P00001 仅由周梅更名为许兰，商品、温水冲泡、500毫升和39元均保留。'}]},c,src).ok,true);
 for(const value of ['500毫升','39元','菊花茶'])assert.equal(a.deterministicAudit(c,src,[{...out[0],text:out[0].text.replace(value,'已删去')}]).ok,false,value);
});
