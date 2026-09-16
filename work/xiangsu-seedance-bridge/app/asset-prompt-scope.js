"use strict";
// Exact legacy boilerplate migrations; do not alter source dialogue or asset
// design facts. Applies after saved defaults AND reference-parity appendices.
function normalizeSceneAssetScope(value){return String(value||"")
 .replace(/从主要入口向内看的正向广角主视图/g,"沿场景主轴的正向广角主视图（户外沿道路或地形方向，室内沿已定义入口方向）")
 .replace(/左上主入口正向广角/g,"左上沿场景主轴正向广角（户外沿道路或地形方向，室内沿已定义入口方向）")
 .replace(/四个不同房间/g,"四个不同空间")
 .replace(/墙面转折、同一道门窗、走廊\/楼梯、主要出入口、固定家具、关键陈设、主题物件锚点/g,"已定义的建筑或地形边界、道路或室内动线、现有出入口与固定空间锚点")
 .replace(/同一道门窗、同一固定家具拓扑/g,"同一组已定义建筑或地形锚点、同一固定布局拓扑")
 .replace(/每一格的沙发、床、椅子都必须空着/g,"每格仅保留本场已定义的建筑、地形与固定陈设，没有定义的家具不得凭空添加");}
function normalizePropAssetScope(value){return String(value||'')
 .replace(/只展示当前物品资产，不加入真人、手或剧情场景。/g,'只展示当前物品资产，物件之外不加入真人、手或剧情场景；实体照片纸面内部保留已审核设计的被摄内容。')
 .replace(/不得出现文字、字幕、标签、伪文字/g,'保留已审核设计中物件表面固有印刷与图案；不得添加额外字幕、水印、悬浮标签、未授权文字或伪文字')
 .replace(/禁止人物、手、剧情场景/g,'禁止物件之外的真人、手和剧情场景；物件内部固有图案按已审核设计保留');}
module.exports={normalizeSceneAssetScope,normalizePropAssetScope};
