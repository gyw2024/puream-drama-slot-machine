# 纯梦短剧老虎机 MCP 连接

v0.14.1 起，桌面应用额外提供标准 MCP stdio 控制入口。正常双击启动、现有界面、项目数据和生产流程均保持原样；只有显式传入 `--mcp-stdio` 时才进入 MCP sidecar 模式。

## 客户端配置

将安装后的程序绝对路径填入支持 MCP 的客户端：

```json
{
  "mcpServers": {
    "puream-drama": {
      "command": "C:\\Users\\Administrator\\AppData\\Local\\Programs\\xiangsu-seedance-bridge\\纯梦短剧老虎机.exe",
      "args": ["--mcp-stdio"]
    }
  }
}
```

MCP sidecar 会连接到唯一运行中的桌面主进程；若应用尚未启动，会自动启动正常桌面应用并等待本地控制通道就绪。主进程托管所有长任务，因此 MCP 客户端断开不会导致已经提交的生产任务丢失。

## 安全与计费

- MCP 与应用之间只使用本机命名管道，并使用每次启动随机生成的 256 位令牌认证。
- stdout 只承载 MCP 协议；诊断信息只写 stderr。
- 不提供 API Key、授权令牌、支付或授权修改工具。
- 任何可能调用付费模型的工具都必须显式传入 `confirm_billable: true`。
- 归档项目必须显式传入 `confirm_archive: true`，且项目有运行任务时会被拒绝。
- 文案、图片和视频费用仍以应用账本为准；本地预估与官网实际结算严格分开。

## 主要能力

只读能力包括应用状态、项目、生产阶段、费用账本、可复用资产和后台操作查询。写入能力包括新建/更新/归档/恢复项目、导入完整剧本或本地资产、确认候选、绑定独立资产，以及选题、剧本识别、资产、分镜图、分镜视频、质检修复、拼接和一键全流程。

可读取资源：

- `puream://app/status`
- `puream://projects`
- `puream://operations`

内置提示模板 `produce_short_drama` 会先检查项目、生产状态与费用，再要求显式确认付费，最后持续查询真实成片状态；不会把“本阶段完成”误报成“全流程完成”。
