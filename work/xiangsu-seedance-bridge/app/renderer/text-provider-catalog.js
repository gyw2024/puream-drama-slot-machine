"use strict";

window.textProviderCatalog = Object.freeze({
  "zhipu-native": {
    tag: "ZHIPU GLM", displayName: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.3", models: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.6", "glm-4.5", "glm-4-plus", "glm-4-flash"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "内置智谱官方兼容接口，只需选择 GLM 模型并填写 API Key。"
  },
  "minimax-native": {
    tag: "MINIMAX HAILUO", displayName: "海螺 MiniMax", baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3", models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2", "abab6.5s-chat"],
    temperature: 1, authSource: "user", domestic: true,
    help: "内置海螺 MiniMax 官方兼容接口，只需选择模型并填写 API Key。"
  },
  "qwen-native": {
    tag: "QWEN DASH SCOPE", displayName: "阿里千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-max", models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3.5-omni-plus", "qwen3-max", "qwen-plus", "qwen-max", "qwen-turbo"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "内置阿里百炼兼容接口，只需选择千问模型并填写 API Key。"
  },
  "kimi-native": {
    tag: "KIMI MOONSHOT", displayName: "Kimi", baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3", models: ["kimi-k3", "kimi-k2.6", "kimi-k2.5", "kimi-k2.7-code", "moonshot-v1-auto", "moonshot-v1-128k"],
    temperature: 1, temperaturePolicy: "fixed-1", authSource: "user", domestic: true,
    help: "Kimi K 系列只允许 temperature=1，软件会自动锁定该参数。"
  },
  "doubao-native": {
    tag: "DOUBAO ARK", displayName: "火山豆包", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-2-1-pro-260628", models: ["doubao-seed-2-1-pro-260628", "doubao-seed-evolving"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "标准方舟使用 Responses API；默认是控制台快速接入页给出的 Seed 2.1 Pro 版本 ID。未开通模型请填写方舟 Endpoint ID。"
  },
  "doubao-coding-plan": {
    tag: "VOLCENGINE CODING PLAN", displayName: "火山方舟 Coding Plan", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    defaultModel: "ark-code-latest", models: ["ark-code-latest"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "Coding Plan 专用地址；ark-code-latest 跟随方舟控制台为套餐选择的当前模型。"
  },
  "deepseek-native": {
    tag: "DEEPSEEK", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash", models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    temperature: 0.3, authSource: "user", domestic: true,
    help: "内置 DeepSeek 官方兼容接口，结构化任务会自动控制思考参数。"
  }
});
