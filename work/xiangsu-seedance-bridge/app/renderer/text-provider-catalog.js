"use strict";

window.textProviderCatalog = Object.freeze({
  "zhipu-native": {
    tag: "ZHIPU GLM", displayName: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5", models: ["glm-4.5", "glm-4.5-air", "glm-4-plus", "glm-4-flash"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "内置智谱官方兼容接口，只需选择 GLM 模型并填写 API Key。"
  },
  "minimax-native": {
    tag: "MINIMAX HAILUO", displayName: "海螺 MiniMax", baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.1", models: ["MiniMax-M2.1", "MiniMax-M2", "abab6.5s-chat"],
    temperature: 1, authSource: "user", domestic: true,
    help: "内置海螺 MiniMax 官方兼容接口，只需选择模型并填写 API Key。"
  },
  "qwen-native": {
    tag: "QWEN DASH SCOPE", displayName: "阿里千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-max"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "内置阿里百炼兼容接口，只需选择千问模型并填写 API Key。"
  },
  "kimi-native": {
    tag: "KIMI MOONSHOT", displayName: "Kimi", baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3", models: ["kimi-k3", "kimi-k2.5", "moonshot-v1-128k"],
    temperature: 1, temperaturePolicy: "fixed-1", authSource: "user", domestic: true,
    help: "Kimi K 系列只允许 temperature=1，软件会自动锁定该参数。"
  },
  "doubao-native": {
    tag: "DOUBAO ARK", displayName: "火山豆包", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-1-6-250615", models: ["doubao-seed-1-6-250615", "doubao-1-5-pro-32k-250115", "doubao-lite-32k-240828"],
    temperature: 0.7, authSource: "user", domestic: true,
    help: "内置火山方舟兼容接口；可选择模型 ID，也可填写 Endpoint ID。"
  },
  "deepseek-native": {
    tag: "DEEPSEEK", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4"],
    temperature: 0.3, authSource: "user", domestic: true,
    help: "内置 DeepSeek 官方兼容接口，结构化任务会自动控制思考参数。"
  }
});
