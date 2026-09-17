# BUG-091：全流程中的物品资产误触发提示词审查重入

## 用户症状

- 完整流程已经确认全部提示词后，人物资产和场景资产可以正常生成，但物品资产批量失败。
- 界面可能显示任务可恢复，但重跑前若不修根因，会在同一资产阶段再次失败。
- 上游没有收到物品生图请求；这不是余额、网络或供应商故障。

## 最深层根因

`generateAllAssets` 已为人物和场景传递 `promptPrepared: true`，表示本轮全流程已经完成统一提示词确认，不得再次进入提示词审查。但是物品/服装分支通过 `ensureLibraryAssetCandidate` 间接调用 `generateLibraryAssetImage`，中间函数没有接收和转发该状态。

因此物品分支再次调用 `preparePromptReviewBundle`。此时项目的合法活动操作正是 `full_pipeline`，重入审查把它误判为并发分析，抛出 `PROJECT_OPERATION_BUSY`。这是调用链契约缺失，而不是模型输出问题。

## 根修复

- `ensureLibraryAssetCandidate` 增加可选参数并把 `promptPrepared` 原样传给 `generateLibraryAssetImage`。
- `generateAllAssets` 的物品/服装分支显式传入 `promptPrepared: true`。
- 保留已有候选的幂等复用：恢复运行只补缺失败资产，不重复提交已成功的人物和场景。

## 回归

- `scripts/prompt-prepared-reentrant-regression.test.js`
  - 场景资产可在已确认的全流程内重入。
  - 分镜资产可在已确认的全流程内重入。
  - 物品/服装资产可在已确认的全流程内重入。
  - 资产批次对所有资产类型统一转发已确认状态。
  - 视频包装器继续转发同一状态。
  - 显式重抽仍不复用历史首张候选。
- 定向结果：6/6 通过。

## 真实运行证据

- 任务：`TASK-20260826-DRAMA-REMARRIAGE-FULL-VIDEO-003`
- 修复前已成功：6 个人物资产、4 个场景资产。
- 修复前失败：8 个物品资产，错误均为 `PROJECT_OPERATION_BUSY`；失败发生在上游提交前。
- 后续验收以同一项目断点续跑、完整分镜视频和最终 MP4 为准。
