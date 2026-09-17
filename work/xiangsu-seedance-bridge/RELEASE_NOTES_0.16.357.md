# 0.16.357 发布说明

## 修复 1：视频身份图检查与资产资格对齐（方案 A）

**根因**：同一批"沉默在场者"（原稿标注全程沉默、不代为发声）在两个模块得到相反判定——
资产侧按剧本设定不建独立形象（`assetBearingCharacters`），视频侧却因名字出现在
`visibleCharacterIds` 里强制要求身份图（`shotReferenceCharacterIds`）。两条规则互斥，
只要这些角色在场，提交必报 `SHOT_CHARACTER_IDENTITY_REFERENCE_REQUIRED`。
实测「新的带货漫剧·测试」37/42 镜命中（刘淑芬 26 镜、亲戚甲乙各 28 镜、全场宾客 9 镜）。

**修法**：新增 `shotIdentityEligibleIds` 过滤——视频身份参考只保留两类人：
本镜实际说话者（含画外发言，锁脸与口型必需）与已建立形象资产者。
三条返回路径（agentProductionDecision / ai-batch / legacy）全部收口；
legacy 分支原先 `declaredVisibleIds` 直通的口子同步收紧。
不改变任何资产的生成与判定，不加生成成本。

**验证**：真实项目 42/42 镜过滤后全部放行；新增
`scripts/shot-identity-eligibility.test.js` 4 项断言（沉默者剔除、说话者保留、
ai-batch 分支、决策分支）；相关 17 个测试文件与改动前基线逐文件对照，零新增失败。

## 修复 2：进度看板 8/13 资产计数文案（承接 0.16.356，此处汇总）

角色/场景计数改为「需资产 X / 全剧 Y」，悬停说明哪些角色按剧本设定不需要独立形象。
仅文案层，不改 `assetRequired` 判定。

## 优化 3：提示词冗余压缩（第二轮）

实测构成：生产决策阶段 instructions.json 约 13.3 万字符，其中逐镜 responseSchema 占 63%；
单镜 schema 块内 52% 是三类机械重复。

本轮去除（语义完全保留）：

1. **逐字段巨型正则去重（读取视图）**：禁串道具负向断言（约 330 字符 × 每镜 15 处）
   在 `modelView` 读取视图中替换为一行说明，指向 `schema.json` 的完整正则。
   request.json / schema.json 保留全部正则字节，提交校验（`conforms`/`inspect`）分毫未动。
2. **道具状态描述去重**："This ID belongs to this exact object…"（88 字符 × 每块 20 处）
   收敛为 schema 根部一次性声明，逐字段只留"State of prop-X (名) only."。

**效果**：存量任务实测 -12.8%；叠加新 schema 构建器，新批次约 -19%
（5 镜批 instructions 13.3 万 → 约 10.8 万字符）。叠加 0.16.356 的 -64.2% 常驻开销，
双轮合计显著缩短模型分页阅读与上下文负担。

## 未做（记录待拍板）

- 逐镜 anyOf 合并（$defs/$ref 或单一 enum）可再省约 60% schema 体积，但会删除逐镜
  `const: shotId` 强约束，有串镜风险，本轮不动。
- 进度看板分母统一默认值（角色 `!== false`）仍搁置，需先核查存量项目缺字段数据。
- 真机跑一批生产决策任务，确认骨架工具 + 压缩视图下一次提交成功率（兜底：
  submit 仍按完整 schema 逐字段校验，needs_revision 可修复）。

## 安装包

- `dist-fixed-0.16.357/纯梦短剧老虎机-安装版-0.16.357.exe`
- 覆盖安装位置：`C:\Users\Administrator\AppData\Local\Programs\xiangsu-seedance-bridge\`
