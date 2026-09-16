const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {observeProduct}=require('../app/product-visual-evidence');
test('product observation is hash-bound and never generates or invents a missing photo',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'product-vision-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'source.png');fs.writeFileSync(file,'fixture');let calls=0;
 const generate=async(m,o)=>{calls++;assert.equal(o.visionImages[0].path,file);assert.match(m[0].content,/Do not generate/);return{packagingDescriptionZh:'黑盖罐',packagingDescriptionEn:'A black-lid jar',containerType:'jar',visibleParts:['lid'],notVisible:['box'],uncertainties:[]};};
 const product={name:'P',imagePath:file};const observed=await observeProduct(product,generate);product.visualEvidence=observed;assert.equal((await observeProduct(product,generate)).sha256,observed.sha256);assert.equal(calls,1);assert.equal(await observeProduct({name:'no photo'},generate),null);
 fs.writeFileSync(file,'changed');await observeProduct(product,generate);assert.equal(calls,2);
});
