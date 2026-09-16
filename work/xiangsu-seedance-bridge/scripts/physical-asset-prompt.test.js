const test=require('node:test'),assert=require('node:assert/strict');
const {physicalAssetPrompt,physicalAssetPromptChinese}=require('../app/physical-asset-prompt'),{normalizePropAssetScope}=require('../app/asset-prompt-scope');
test('approved asset design compiles to stage-exclusive English without mixed old video policies',()=>{
 const entity={descriptionEn:'A silver-haired elderly woman wearing a navy cardigan.',visualDesign:{}};
 const portrait=physicalAssetPrompt('character_intro',entity);assert.match(portrait,/one person for an individual/);assert.match(portrait,/explicitly authored ensemble/);assert.doesNotMatch(portrait,/[\u3400-\u9fff]/u);assert.doesNotMatch(portrait,/exactly four/);
 const scene=physicalAssetPrompt('scene_asset',{...entity,descriptionEn:'An empty outdoor T-junction.'});assert.match(scene,/16:9/);assert.match(scene,/2 by 2/);assert.doesNotMatch(scene,/silver-haired/);
 assert.match(scene,/outdoor views follow authored road or terrain geometry/);
 const indoor=physicalAssetPrompt('scene_asset',{...entity,descriptionEn:'Indoor community station with a service desk and a south-wall door.'});assert.match(indoor,/indoor views retain its authored walls, doors and fixed furniture/);assert.doesNotMatch(indoor,/never invent an indoor door/);
 assert.equal(physicalAssetPrompt('storyboard_start',entity),'');assert.equal(physicalAssetPrompt('character_intro',{descriptionEn:'unsupported'}),'');
});
test('paired Chinese physical review keeps approved state instead of re-translating it',()=>{
 const entity={description:'南墙东端为虚掩的绿色防盗门，东侧铰链向内开启。',descriptionEn:'An ajar green security door at the east end of the south wall, eastern hinges opening inward.',visualDesign:{}};
 const before=physicalAssetPrompt('scene_asset',entity),zh=physicalAssetPromptChinese('scene_asset',entity);
 assert.match(zh,/虚掩/);assert.doesNotMatch(zh,/半开/);assert.match(zh,/16:9/);assert.match(zh,/左上.*正向.*右上反向/);assert.equal(physicalAssetPrompt('scene_asset',entity),before);assert.doesNotMatch(before,/[\u3400-\u9fff]/u);
 assert.equal(physicalAssetPromptChinese('storyboard_start',entity),'');assert.equal(physicalAssetPromptChinese('scene_asset',{...entity,description:'English only'}),'');
 assert.equal(physicalAssetPromptChinese('scene_asset',{...entity,visualDesign:{descriptionEn:'Different manually changed design.'}}),'');
});
test('photos and printed evidence preserve intrinsic content while excluding external people and overlays',()=>{
 const prompt=physicalAssetPrompt('prop_asset',{descriptionEn:'A printed paper photograph of a courier helping an elder.',visualDesign:{}});assert.match(prompt,/INSIDE/);assert.match(prompt,/intrinsic printing/);
 const fixed=normalizePropAssetScope('只展示当前物品资产，不加入真人、手或剧情场景。不得出现文字、字幕、标签、伪文字');
 assert.match(fixed,/纸面内部保留/);assert.match(fixed,/表面固有印刷/);assert.doesNotMatch(fixed,/不得出现文字、字幕/);
});

test('collection counts and mounted supports remain owned by the approved design in both languages',()=>{
 const entity={descriptionEn:'Exactly three independent closed umbrellas and three hooks fixed to their approved wall.',description:'恰好三把独立合拢雨伞和固定在既定墙面的三只挂钩。',visualDesign:{}};
 const en=physicalAssetPrompt('prop_asset',entity),zh=physicalAssetPromptChinese('prop_asset',entity);
 assert.match(en,/approved number of physical objects/);assert.match(en,/Mounted or fixed objects retain/);assert.match(en,/never detach them/);assert.ok(en.includes(entity.descriptionEn));
 assert.doesNotMatch(en,/show one complete photorealistic object|No external actors, hands, holders or story environment/);
 assert.match(zh,/一条资产记录不等于一个物件/);assert.match(zh,/不拆卸、不移到摄影台上/);assert.ok(zh.includes(entity.description));
});
