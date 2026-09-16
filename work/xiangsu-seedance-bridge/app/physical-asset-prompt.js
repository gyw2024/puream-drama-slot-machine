"use strict";
function physicalAssetPrompt(stage,entity={}){
 const authored=require('./asset-prompt-author').output(stage,entity);if(authored)return authored;
 const design=String(entity.descriptionEn||entity.visualDesign?.descriptionEn||'').trim();
 // Keep complete Agent-authored descriptions available to prompt review.
 // Chinese source names or unquoted engravings are not missing deliveries.
 if(!entity.visualDesign||!design)return '';
 const portrait=stage==='character_intro',character=portrait||['character_sheet','character_three_view'].includes(stage);
 const scene=stage==='scene_asset',prop=stage==='prop_asset';
 if(!character&&!scene&&!prop)return '';
 const layout=portrait
  ? 'One photorealistic identity photograph, a vertical three-quarter-length view with complete heads and relaxed hands visible. The approved entity design determines the exact people and count: one person for an individual, every specified distinct member together for an explicitly authored ensemble. Never merge several people into one face or add unnamed members. No panels or collage. All shown people face the camera with closed lips; this is a reference asset, never a story shot.'
  : character
   ? 'One photorealistic identity reference board showing exactly four equally scaled full-body views of the same approved identity, ordered left to right: front, left profile at 90 degrees, right profile at 90 degrees, back. For an explicitly authored ensemble, each view contains the exact same distinct members and count from the approved design; otherwise each view contains the one approved person. Preserve every face, age, build, hair and outfit across views; aligned feet and complete uncropped limbs. No extra view, close-up insert or unapproved identity.'
   : scene
    ? 'One photorealistic 16:9 image containing a regular 2 by 2 four-view board of ONE empty physical location. Panel order: upper left forward along the established main axis, upper right reverse, lower left leftward 45-degree view, lower right rightward 45-degree view. All four views share exactly the approved geometry, entrances, fixed objects, materials and lighting. Follow the approved location type: indoor views retain its authored walls, doors and fixed furniture; outdoor views follow authored road or terrain geometry without introducing interior furniture. No live people, silhouettes or reflections of live occupants, movable story props or product placement. Preserve approved fixed wall portraits and medals; printed people inside pictures are not live occupants.'
    : 'One reference image in exactly the representation specified by the approved design. Preserve the approved number of physical objects, including every distinct member of a collection; one asset record does not mean one object. Show complete photorealistic objects with soft even light. Freestanding portable objects use a neutral studio surface with a real contact shadow. Mounted or fixed objects retain their approved attachment, orientation, spacing and necessary supporting wall or structure; never detach them or move them onto a studio table. Include only the support context needed by the approved design, with no unrelated story environment. For standalone digital imagery or display content, render the approved image itself at its stated aspect ratio, without inventing a physical carrier, studio surface, hardware casing or contact shadow. Preserve approved dimensions, material, wear and current state. No external actors, hands or holders. A photograph may depict the source-approved scene and people INSIDE its printed paper surface only; never turn them into actors outside the object. Approved intrinsic printing or an image is part of the prop, not a forbidden subtitle. Do not invent printing, names, numbers or evidence absent from the approved design.';
 const background=character?' Background is uniformly #E9E9E9 across the whole image, with no gradients, scenery, floor horizon, black borders or decorative lighting. Preserve the source age, including elders or minors; never recast the person as another age.':'';
 return `${layout}\n\nApproved physical design: ${design}\n\n${background} No added titles, captions, subtitles, identity labels, watermarks, interface elements or explanatory overlays. Do not redesign the locked product or substitute its packaging. Any supplied image references retain their actual identity and physical details; do not invent absent reference inputs.`.trim();
}
function physicalAssetPromptChinese(stage,entity={}){
 const authored=require('./asset-prompt-author').output(stage,entity,'zh');if(authored)return authored;
 const design=String(entity.visualDesign?.descriptionZh||entity.description||'').trim();
 if(entity.visualDesign?.descriptionEn&&entity.descriptionEn&&entity.visualDesign.descriptionEn!==entity.descriptionEn)return '';
 if(!physicalAssetPrompt(stage,entity)||!/[\u3400-\u9fff]/u.test(design))return '';
 const portrait=stage==='character_intro',character=portrait||['character_sheet','character_three_view'].includes(stage);
 const layout=portrait
  ? '一张写实单人身份参考照片，竖向四分之三身长构图，完整头部和放松的双手可见。一个身份、一个身体、一张脸，无分栏或拼图。人物面向镜头、双唇闭合；这是参考资产，不是剧情镜头。'
  : character
   ? '一张写实身份参考板，恰好四幅等比例全身视图，从左至右依次为正面、左侧90度、右侧90度、背面。四幅中的面容、年龄、体型、发型和全套服装相同，脚底对齐，四肢完整不裁切；无第五个人影、特写插图或第二身份。'
   : stage==='scene_asset'
    ? '一张写实16:9图片，规则2×2四视图，同一个空置实体场所。左上沿既定主轴正向，右上反向，左下左偏45度，右下右偏45度。四幅共享完全一致的已批准几何、入口、固定物件、材质和光线。室内保留既定墙壁、门和固定家具；室外遵循既定道路或地形，不添加室内家具。无场内真人、真人轮廓或倒影、可移动剧情道具或商品植入。保留已批准的固定墙面遗像和军功章；照片内部的印刷人物不属于场内真人。'
    : '一张参考图，严格采用已批准设计指定的呈现形式。保留已批准的实体物件数量，包括组合资产中的每个独立成员；一条资产记录不等于一个物件。完整展示写实物件，使用柔和均匀光线。可独立放置的便携物件置于中性摄影台面，保留真实接触阴影。安装或固定物件保留已批准的连接方式、朝向、间距及必要支撑墙面或结构，不拆卸、不移到摄影台上。只纳入设计必需的支撑环境，不加入无关剧情环境。独立数字影像或显示内容则以指定画幅呈现图像本身，不发明实体载体、摄影台、设备外壳或接触阴影。保留已批准的尺寸、材质、磨损和当前状态。不出现物体外部的演员、手或持有人。照片只在相纸内部呈现源稿批准的印刷人物与场景，不把其变为物体外的演员；固有印刷和图像属于道具本身，不属于字幕。不虚构设计之外的印刷、姓名、数字或证据。';
 const background=character?'背景全幅统一为#E9E9E9，无渐变、布景、地平线、黑边或装饰光。保留源稿年龄，包括老人或未成年人，不改为其他年龄。':'';
 return `${layout}\n\n已批准的实体设计：${design}\n\n${background}禁止额外标题、说明、字幕、身份标签、水印、界面元素和解释性覆盖文字。不重设计锁定商品或替换包装。若提供参考图，保留其真实身份和物理细节；不虚构不存在的参考输入。`.trim();
}
module.exports={physicalAssetPrompt,physicalAssetPromptChinese};
