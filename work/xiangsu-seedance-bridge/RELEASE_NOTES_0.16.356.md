# 0.16.356 — 投递载荷去重与资产计数文案

两项改动：**让投递给模型的提示词不再把同一份输出 schema 复制四遍**，以及**修掉「人物角色 8/13」这处会被读成"还差 5 个没做"的文案**。

本次不改任何内容要求、不改模型选择、不改 `assetRequired` 的判定逻辑，只改载荷序列化方式与界面文字。

## 一、同一份输出 schema 被复制四份

### 实测证据

取本机真实任务 `agent fbe9e310`（`master_production_decisions`，5 镜 scope）逐层测量，模型上下文里实际存在 **4 份同一份 `responseSchema`**：

| 承载位置 | 改动前字符 | 谁读 |
| --- | --- | --- |
| `instructions.json` 内（`JSON.stringify(...,null,2)`） | 178,102 | **模型必读**（transport 要求 follow nextOffset until null） |
| `submit_stage_result` 工具定义内联 `properties.data` | 82,844 | **常驻**（每轮请求都带） |
| `stage_result_part` 工具定义内联 `properties.data` | 82,739 | **常驻** |
| `schema.json`（缩进 2） | 170,700 | 按需 |

`responseSchema` 的紧凑真身只有 **82,844 字符**，而它在一次任务里被原生承载 **514,385 字符**。

进一步拆解 `instructions.json`（225,890 字符）：

```
responseSchema  170,700   75.6%   ← 其中 87,856 是纯缩进空格
messages         46,712   20.7%
其他                479    0.2%
```

schema 内部还在逐镜重复：`objectStates` 一份 8,177 字符，5 个镜头分支各存一份（浪费 32,708），`objectStates.items` 同理浪费 32,556。36 个历史样本的 scope 全是 5 镜（符合 TASK_BATCH 每批不超过 5 条），即每批都要重付这份钱。

### 根因

- `app/mcp/stage-files.js` 用 `JSON.stringify(view,null,2)` 生成 `instructions.json` / `schema.json`，而这两个文件是**按字符偏移分页**读给模型的，缩进对阅读毫无帮助，纯粹是多付的空格。
- `app/mcp/stage-delivery-server.js` 把**完整** `responseSchema` 内联进 `submit_stage_result` 与 `stage_result_part` 两个工具定义。MCP 工具定义是常驻上下文，于是同一份 schema 又多两遍。

### 修复

1. **紧凑序列化**：`instructions.json` 与 `schema.json` 改用 `JSON.stringify(view)`。分页本来就是 `offset`/`nextOffset` 字符定位，去缩进不影响读取。
2. **工具定义只广告顶层骨架**：新增 `stage-parts.interfaceSkeleton(schema, depth=5)`，保留**顶层 `required`、字段名、列表项 `required`、逐镜 `const`（`shotId` 等）**，砍掉每镜重复的内层字段定义。模型据此仍知道「该交什么、每个 item 有哪些字段、哪一份属于哪个 shot」，而**精确的内层结构仍由 `instructions.json` 完整提供**（transport 本来就强制读完它）。
3. 在 `read_stage_file` / `submit_stage_result` / `stage_result_part` 的说明与 `FILE_INSTRUCTION`、`taskPointer` 中写明：工具广告只是顶层形状，完整结构在 `instructions.json`。

### 收益（真实任务实测）

| | 改动前 | 改动后 | 省 |
| --- | --- | --- | --- |
| `instructions.json`（模型必读） | 225,890 | 130,460 | 95,430（**-42.2%**） |
| `schema.json`（按需） | 170,700 | 82,844 | 87,856 |
| `submit_stage_result` 工具定义 | 83,030 | 4,568 | 78,462 |
| `stage_result_part` 工具定义 | 83,260 | 5,424 | 77,836 |
| **每批任务必付**（常驻 + 必读） | **392,180** | **140,452** | **-64.2%** |

常驻部分的削减尤其关键：工具定义每轮 API 请求都会带上，`master_production_decisions` 每批动辄数十轮工具调用，原来每轮都在重传 16 万字符。

### 为什么不动 schema 内部的逐镜重复

`agent-production-decisions.js` 的 `anyOf` 是**逐镜头**生成的，5 个分支各自内嵌一份完整字段定义，这是本次剩余的最大一块重复（约 6 万字符）。**未动**，因为两条可能的合并路径都有实质风险：

- 提到 `$defs` 用 `$ref` 引用：需要模型与本地校验器 `agent-output-normalization.inspect()` 同时正确处理 `$ref`，当前两者都未验证支持。
- 改成 `shotId: {enum:[...]}` 的单一 object schema：会删掉每个分支的 `const: "shot-NN"` 强约束——正是这条约束让模型在分支内只能写这一镜，去掉后串镜风险明显上升，而串镜直接违反「严格对应」底线。

需要你单独拍板是否承担该风险，本次不擅自处理。

## 二、「人物角色 8 / 13」的文案歧义

### 实测证据

项目 `project_mu3jpj5t_f2b858d7` 的角色数据与三处计数完全自洽：

```
promptReview.counts = { characters: 8, scenes: 3, objects: 4, videos: 42, total: 57 }   8+3+4+42 = 57 ✓
promptReview.items 中 character:char-*:character_intro 恰好 8 条 ✓
13 个角色里 assetRequired===true 恰好 8 个 ✓
19 个道具里 assetRequired===true 恰好 4 个（对应 objects: 4）✓
```

被跳过的 5 个角色（刘淑芬、亲戚甲、亲戚乙、司仪、全场宾客）字段结构本就不同：需要资产的 8 个有 15 个字段（含 `gender`/`appearanceDescription`/`visualDesign`），这 5 个只有 6 个，因为剧本设定它们是沉默在场者、画外报幕（明确「不露面」）和群体，需要的是音色而非人物身份图。

**所以 8/13 不是 bug，但界面上会被读成"13 个里还有 5 个没做完"。**

### 根因

`app/renderer/workbench.js`：

```js
const assetCharacters = project.characters.filter(c => c.assetRequired === true);   // :2297
$("#characterCount").textContent = `${assetCharacters.length} / ${project.characters.length}`;   // :2392
$("#sceneCount").textContent = assetScenes.length;   // :2393  ← 同类指标却是单个数字，格式不一致
```

分子是「需要建立形象资产的角色数」，分母是「剧本全部角色数」，两者不是进度关系，永远到不了 13/13。而 `workbench.css:398` 把它渲染成 19px 高的胶囊徽标，形状本身就像进度。

### 修复（只改文案，未改判定）

- 两个计数统一为同一格式：`需资产 8 / 全剧 13`（角色）、`需资产 3 / 全剧 4`（场景）。
- 加 `title` 悬停说明：全剧共几个、几个需要形象、其余为什么不需要，并指向角色网格下方**既有**的「未建立独立资产 N 人（画外 / 背景 / 临时龙套）」折叠名单。
- `assetCharacters` 的 `=== true` 与 `assetScenes` 的 `!== false` 判定**原样保留**（`sceneCount` 的行为完全未变）。

### 仍然存在但本次不动的隐患

两个筛选规则的默认值方向相反：场景用 `!== false`（缺字段即默认需要），角色用 `=== true`（缺字段即静默跳过）。若某来源的剧本角色数据缺 `assetRequired` 字段（旧项目、导入稿、Agent 漏填），会被静默跳过而不生成形象，界面上只表现为分子少一个，无法分辨是「本来就不需要」还是「判定丢了」。当前项目数据字段齐全，未触发。修这个会改变生产行为（可能让老项目突然多出一批待生成角色），需要你确认后单独处理。

## 三、验证与未验证

**已验证**

- 新增 `scripts/stage-payload-compactness.test.js`（6 项）：紧凑序列化、工具定义不含内层字段体、骨架保留顶层 `required`/字段名/逐项 `required`/逐镜 `const`、`interfaceSkeleton` 对畸形输入不抛错、真实提交仍按**完整** schema 校验。
- 定向回归 12 个文件逐文件与**未改动基线**对照，结果**完全一致、零回归**：
  `mcp-stage-delivery` 15/15、`stage-file-delivery` 10/10、`stage-parts-required-keys` 3/3、`stage-singleton-envelope` 4/4、`response-schema-routing` 2/2、`local-agent-integration` 23/23、`mcp-external-agent-release` 3/3、`ui-integration-regression` 5/5；`screenplay-repair-delivery` 6/7、`script-review-repair-222` 9/10、`account-review-recovery-224` 2/5、`prompt-review-dialog-regression` 4/5 为**改动前既有失败**，改动前后数字完全相同。
- 其中 `mcp-stage-delivery.test.js:61` 与 `:9` 两条既有契约断言（工具定义必须仍暴露 `required` 与字段名）在骨架化后依然通过。
- 包内 `app.asar` 代码标记校验：待打包完成后确认。

**未验证**

- 未用真实 Agent 跑一次完整批次来观察「模型只靠 instructions.json 的完整 schema 能否一次提交成功」。有兜底：`preview_stage_result` 与 `submit_stage_result` 仍按完整 schema 逐字段校验，结构不对会返回字段级 `needs_revision`（新测试第 6 项已锁定这一点）。若实际观察到返工轮次上升，回滚方式见下。
- 未在真实项目上观察新文案的实际观感（胶囊宽度、悬停提示）。

## 四、回滚

三项改动彼此独立，可单独回滚：

| 改动 | 回滚 |
| --- | --- |
| 紧凑序列化 | `stage-files.js` 两处 `JSON.stringify(x)` 改回 `JSON.stringify(x,null,2)` |
| 工具定义骨架 | `stage-delivery-server.js` 两处 `interfaceSkeleton(...)` 去掉该层调用 |
| 界面文案 | `workbench.js:2399-2410` 恢复原两行赋值 |

回滚后 `stage-payload-compactness.test.js` 会失败——这是有意设计：它锁的就是这次优化，避免下次有人把缩进或完整 schema 加回来。
