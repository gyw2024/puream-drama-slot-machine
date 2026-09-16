"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { publicError, sanitizePublicMessage } = require("../app/public-error");

test("用户错误提示保留可行动信息但不泄露上游地址、模型或请求内部", () => {
  const message = sanitizePublicMessage(
    "HTTP 500 model=dubious-model endpoint=https://provider.example/v1 request id=req_123 api_key=secret"
  );
  assert.match(message, /官方服务|服务配置|请求编号/);
  assert.doesNotMatch(message, /provider\.example|dubious-model|req_123|secret/);
  assert.equal(publicError(new Error("user quota is not enough (request id: req_123)")).message,
    "当前账户额度不足，请充值或更换有额度的账户后重试");
});

test("限流与余额不足不会被混为同一类提示", () => {
  assert.equal(
    publicError(Object.assign(new Error("quota window is still closed"), { code: "PROVIDER_RATE_LIMITED" })).message,
    "上游当前限流，现有进度已保存；软件会按恢复窗口续接同一任务，不会重写已完成内容"
  );
  assert.equal(
    publicError(Object.assign(new Error("user quota is not enough"), { code: "local:insufficient_quota" })).message,
    "当前账户额度不足，请充值或更换有额度的账户后重试"
  );
  assert.equal(
    publicError(Object.assign(new Error("daily quota"), { code: "PROVIDER_DAILY_QUOTA_EXHAUSTED" })).message,
    "模型项目的日配额当前不可用，现有进度已保存；可在配额恢复后继续，或切换有可用额度的模型"
  );
});

test("原始传输异常不会进入任何客户可见错误面", () => {
  for (const raw of ["fetch failed", "TypeError: fetch failed", "UND_ERR_SOCKET", "socket hang up", "ECONNRESET"]) {
    const message = publicError(Object.assign(new Error(raw), {
      code: "REFERENCE_MEDIA_UPLOAD_RETRYABLE",
      retryable: true,
      noRemoteTaskCreated: true
    })).message;
    assert.equal(message, "网络短暂中断，软件会从原任务断点自动恢复，不会重复创建付费任务");
    assert.doesNotMatch(message, /fetch failed|TypeError|UND_ERR|socket hang up|ECONNRESET/i);
  }
});

test("应用授权故障、设备策略与模型密钥错误按错误域分流", () => {
  const serviceOffline = publicError(Object.assign(
    new Error("纯梦官网授权服务暂时不可达"),
    { code: "LICENSE_OFFLINE", status: 503 }
  ));
  assert.equal(serviceOffline.message, "应用授权服务正在恢复，请保持联网后稍后点击在线激活；无需修改文本模型配置");
  assert.doesNotMatch(serviceOffline.message, /模型授权无效/);

  const deviceBound = publicError(Object.assign(
    new Error("该授权码已绑定其他设备"),
    { code: "DEVICE_BOUND", status: 403, kind: "authorization" }
  ));
  assert.equal(deviceBound.message, "该授权码已绑定其他设备，请联系管理员解绑；管理员授权码不会受设备数量限制");

  const providerAuth = publicError(Object.assign(
    new Error("HTTP 401 unauthorized invalid api key"),
    { code: "PROVIDER_AUTH_FAILED", status: 401, kind: "provider" }
  ));
  assert.equal(providerAuth.message, "模型授权无效，请检查授权配置后重试");

  const unclassifiedAuthorization = sanitizePublicMessage("官网授权服务暂时不可达", "UPSTREAM_SERVICE_UNAVAILABLE");
  assert.doesNotMatch(unclassifiedAuthorization, /模型授权无效/);
});
