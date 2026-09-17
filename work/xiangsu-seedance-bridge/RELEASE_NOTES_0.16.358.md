# 0.16.358 发布说明

## 修复：资产全部完成后，引导仍卡在"准备资产"并常驻"AI 补齐全部资产"按钮

**根因**（`app/renderer/workbench.js`）：

1. 下一步引导的缺失清单（`nextActionForProject` 的 `missingAssets`）用**全量**
   characters/props/wardrobes 判缺，没按资产资格过滤——
   - 5 个按剧本设定不需要独立形象的角色（沉默在场者/群体，`assetRequired=false`）
     被永远算作"缺失"；
   - 15 个非核心道具（`assetRequired !== true`）同样永远算缺失；
   - 换装不滤 `changeRequired=false` 与默认服装。
   实测「新的带货漫剧·测试」：旧口径**永远 20 项缺失**（真实需求 0 项），
   引导因此永远停在"下一步：准备资产"，按钮永远挂着，与"本阶段已完成 7/7、
   资产已就绪"自相矛盾。
2. `#generateAllAssets` 按钮对非资产包项目无条件显示（`hidden = false`），
   与就绪状态无关。

**修法**：

- 提取 `missingRequiredAssets(project)`：人物 `assetRequired===true`、场景
  `assetRequired!==false`、道具 `assetRequired===true`、换装排除
  `changeRequired===false`/默认服装/内置默认 wardrobe——与资产生成队列和
  0.16.356 计数器（需资产 X / 全剧 Y）同一口径。
- 引导与按钮共用该函数：缺失为 0 时引导自动前进到下一环节（分镜图/视频），
  "AI 补齐全部资产"按钮隐藏（单项重新抽卡仍保留在各资产卡片上）。

**验证**：真实项目数据模拟——新口径缺失 0 项（8 人物+3 场景+4 道具全部就绪），
旧口径 20 项；`node --check` 语法通过。需真机确认：资产页按钮消失、
引导条显示"下一步：准备分镜图"。

## 遗留

- 进度看板分母默认值统一（角色 `!== false`）仍搁置，需先核查存量项目缺字段数据。
- 逐镜 anyOf $defs/$ref 合并（约可再省 60% schema）有串镜风险，未动。
