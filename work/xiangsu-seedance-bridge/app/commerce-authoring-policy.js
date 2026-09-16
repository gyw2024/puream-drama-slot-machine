'use strict';
const VERSION='commerce-first-pass-20260910-v10-ordered-first-delivery';
const {SYSTEM_PROMPT}=require('./commerce-performance-system-prompt');
const clean=v=>String(v??'').trim();
const placeholder=s=>!clean(s)||/^(?:根据产品特性自由编辑|根据商品特性自由编辑|暂无|无|待补充|自行发挥|自由发挥|不知道|不清楚|AI自动|自动判断|请填写.*)$/i.test(clean(s));
function suppliedEntries(product={}){return [...new Set([product.sellingPoints,product.description].flat().map(clean).flatMap(s=>s.split(/[\n；;。]+/)).map(clean).filter(s=>!placeholder(s)))];}
const productionOnly=value=>/^(?:不(?:得|允许|要)?(?:宣称|声称|添加|编造).*(?:功效|卖点|价格|活动)|(?:包装|商品)(?:外观|文字|颜色|比例|形状)?.*(?:以|沿用|保持).*(?:原图|参考图)|(?:提示词|分镜|参考资产|镜头|字幕|水印)(?:必须|不要|不得|禁止|要求|应当)).*$/u.test(value);
function suppliedFacts(product={}){return suppliedEntries(product).filter(x=>!productionOnly(x));}
// Commercial terms stay in their typed input fields, not inferred selling points.
// Only lossless copies are normalized; an altered price or extra claim still fails.
function normalizeProfile(profile={},product={}){
 const result=structuredClone(profile),terms=['price','offer','purchaseInstructions'].map(k=>clean(product[k])).filter(Boolean),changes=[];
 result.sellingPoints=(Array.isArray(result.sellingPoints)?result.sellingPoints:[]).filter(point=>{
  if(point.basis!=='user'||suppliedFacts(product).includes(clean(point.text)))return true;
  let rest=clean(point.text).replace(/^(?:价格与活动明确|价格与活动|商品价格|价格|活动|购买方式|购买路径)[：:]/,'');
  let matched=0;for(const term of [...terms].sort((a,b)=>b.length-a.length)){if(rest.includes(term)){matched++;rest=rest.split(term).join('');}}
  if(matched&&/^[\s，,；;。、：:]*$/.test(rest)){changes.push({kind:'commercial_terms_in_selling_points',original:structuredClone(point)});return false;}
  return true;
 });
 return {profile:result,changes};
}
const VISUAL_POLICY='商品必须由剧情中的具名人物在原场景内持有、操作、选择或递交，人物身份与商品持用关系明确，允许同一人物剧情中的局部特写，不强制脸和身体每帧同现。每个商品镜及其子镜都保留至少一个真实在场角色ID；禁止独立产品镜、纯包装广告卡、悬浮商品、仅商品或仅不明身份手部的特写。细节通过人物中近景中的持物动作和构图强调，不切走人物。原稿若有独立商品插镜，保留商品信息与对白，改由同一在场人物承担展示，不改动用户原话。';
const PRODUCT_POLICY='用户明确提供的卖点、商品名、价格、活动和购买方式优先且逐项保留。空白及“根据产品特性自由编辑”等占位符不是事实，也不能阻止写作。没有卖点时，AI在同一次写作中根据产品名识别品类，自主推断通常用途、日常使用情境、选购角度和人物需求，写入commerceProfile并据此植入；不要要求用户补填才能继续。名称含义不明确时选择日常选购/赠予/收纳等不依赖具体性能的角度，不猜具体成分、材质、剂量、认证、价格、优惠或疗效。名称明确包含的规格/特点可用于选品，品类常识推断须标记category_use；它是推断而不是已核实的厂家宣称。用户有资料时，用推断补齐剧情情境，不覆盖或改造原事实。普通食品不能治病、急救、替代治疗或暗示恢复健康。未知结构、冲泡或使用方法不演示；可拆洗杯盖不等于能当饮水杯，不能擅自设计拆成几截或倒热水饮用。没有依据时，由具名人物持原包装结合剧情需求解释和选择，不强制拆解、试吃或性能实验。商品段落优先由同一个展示人连续支撑商品及其部件；其他人物用对话和表情回应，避免为了热闹添加无必要的多次递交。剧情确需转交时，先结束当前使用，明确双方接触和接稳结果，再由新持有人操作。不能仅凭食品名推断术后、病后等特定健康状态人群适用性。可通过人物挑选、介绍、赠予、陪伴使用情境完成植入。';
const PATTERNS={
 care_demonstration:'照护需求：人物在吃饭、探望、家务等具体行动中遇到不便，由同场人物提出合适商品、解释日常用途、保持人物入画展示，再回到照护关系。',
 gratitude_support:'善意回流：先完成救助/帮助的剧情行动，再由受助者了解对方经营或生活需要，人物亲自介绍商品与真实活动，以购买/支持回应善意。',
 relationship_reward:'关系兑现：通过真实选择揭示谁值得信任，在情绪已落地后由原人物持物分享；优惠只能来自用户资料，不能照抄样片虚构老板补贴或限量。',
 problem_solution:'生活难题：先让角色表现清洁、收纳、随身携带等日常困扰，再由另一角色提出品类方案、解释选择、展示允许的动作并回到原剧情。',
 craft_teaching:'手艺分享：从人物做饭/照顾家人的行动和他人询问引出商品，讲清有依据的特点和适用情境，最后回收人物关系；不复制样片未经提供的配方或用量。',
};
const FIRST_PASS_POLICY=`FIRST-PASS CONTRACT (${VERSION}): 新编剧本在一次模型请求中交付完整规划与全部连续场次，先在模型内部完成商品策略、道具持有人/交接、场景进出、说话人与听者、商品事实、开场冲突、结尾兑现的交叉核对，再只输出最终JSON。不要先输出计划等待下一轮，不按场分多次写、不把审核问题留给后续收费改稿。剧本、资产提示词、分镜图提示词、视频提示词仍各属独立阶段，阶段内首次交付前自检同一份验收合同。验收失败保留原回复，Agent先核实根因再最小范围修复；相同输入无进展不盲目重复调用；不得通过降低验证标准或伪造通过率满足95%目标。`;
function context(product={}){return {productName:clean(product.name),suppliedFacts:suppliedFacts(product),productionConstraints:suppliedEntries(product).filter(productionOnly),price:clean(product.price),offer:clean(product.offer),purchaseInstructions:clean(product.purchaseInstructions),commercialTermsRule:'productionConstraints只约束创作与包装一致性，不是商品卖点，不写成角色销售台词。价格、活动、购买路径独立保留，不写入sellingPoints。basis=user只能逐字引用suppliedFacts；没有用户卖点时用name/category_use推断普通用途，不把促销条件当功能卖点。',inferenceRequired:suppliedFacts(product).length===0,policy:PRODUCT_POLICY};}
function validateProfile(profile={},product={}){
 const issues=[];const facts=suppliedFacts(product);const name=clean(product.name);
 const points=Array.isArray(profile.sellingPoints)?profile.sellingPoints:[];
 for(const point of points){const text=clean(point.text);if(!text||!['user','name','category_use'].includes(point.basis)){issues.push('卖点必须有完整文字及user/name/category_use来源');continue;}
  if(point.basis==='user'&&!facts.includes(text))issues.push('用户卖点引用必须与用户原资料完全一致');
  if(point.basis==='name'&&(!clean(point.evidence)||!name.includes(clean(point.evidence))))issues.push('名称推断缺少商品名中的原文依据');
  const positiveClaims=text.replace(/(?:本品|本商品|该商品)?不(?:涉及|宣称|承诺)(?:任何)?(?:疾病|调理|治疗|治愈|疗效|认证|医生推荐|临床|量化保证|[、或和及])+(?:用途|功效|效果|承诺|保证)?/g,'').replace(/不能(?:替代|代替)(?:药物|医疗|正规)?治疗/g,'');
  if(point.basis!=='user'&&/治疗|治愈|降血|抗癌|急救|疗效|认证|医生推荐|临床|保证|百分之|\d+\s*%|永久|零副作用|一键|自动开|烫口|彻底洗净|厚实耐用/.test(positiveClaims))issues.push('名称或品类推断不能生成疗效、认证或量化保证');
  if(point.basis!=='user'&&(text.match(/\d+(?:\.\d+)?\s*(?:毫升|厘米|毫米|千克|公斤|小时|分钟|毫安时|ml|kg|cm|mm|升|克|斤|米|瓦|伏|片|包|个|次|天|年|g|l|m|w|v)?/gi)||[]).some(token=>!name.toLowerCase().replace(/\s+/g,'').includes(token.toLowerCase().replace(/\s+/g,''))))issues.push('推断卖点不能添加未经提供的具体数值');
 }
 if(!facts.length&&name&&!points.length)issues.push('缺少名称/品类自主推断的日常卖点');
 if(profile.referencePattern&&!Object.hasOwn(PATTERNS,profile.referencePattern))issues.push('带货方式不属于系统支持的剧情植入逻辑');
 return issues;
}
function acceptedFacts(product={}){const explicit=suppliedFacts(product),profile=product.commerceProfile;if(!profile||validateProfile(profile,product).length)return explicit;return [...new Set([...explicit,...(profile.sellingPoints||[]).map(p=>clean(p.text)).filter(Boolean)])];}
function characterProductIssues(shots=[]){const out=[];for(const shot of shots){const candidates=[shot,...(shot.subshots||[])];for(const [i,item]of candidates.entries()){
  if(!(item.productMention===true||(i>0&&shot.productMention===true)||/product_(?:packshot|detail|use|result|reaction|presentation|interaction)/i.test(`${item.productShotType||''} ${item.shotFunction||''} ${item.shotType||''}`)))continue;
  const ids=Array.isArray(item.visibleCharacterIds)?item.visibleCharacterIds:(i>0?shot.visibleCharacterIds:[]);
  if(!ids?.length)out.push({code:'PRODUCT_CHARACTER_CONTEXT_REQUIRED',shotId:shot.id||'',message:'商品镜及子镜必须保留剧情人物，不能只有独立商品画面'});
 }}return out;}
module.exports={SYSTEM_PROMPT,VERSION,VISUAL_POLICY,PRODUCT_POLICY,FIRST_PASS_POLICY,PATTERNS,suppliedFacts,placeholder,context,validateProfile,acceptedFacts,characterProductIssues,normalizeProfile};
