"use strict";
// 六个用户模型选择控件的唯一严格读取实现（GPT §9.1/§9.2）。
// 既用于浏览器渲染进程（window.DramaSlotIntentControls），也用于 node 测试。
// 合同：提交时必须严格校验，不得用 ?.value || 默认值 静默回退；
// 默认值只允许出现在初始化与旧项目迁移里。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DramaSlotIntentControls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const VALUES = Object.freeze({
    scriptHandling: Object.freeze(["respect", "optimize", "recreate"]),
    commerceMode: Object.freeze(["none", "natural", "explicit"]),
    priorityProfile: Object.freeze(["speed", "balanced", "quality"])
  });
  const SUFFIX = Object.freeze({
    scriptHandling: "ScriptHandling",
    commerceMode: "CommerceMode",
    priorityProfile: "PriorityProfile"
  });
  function fault(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function validateIntent(field, value) {
    if (!Object.hasOwn(VALUES, field) || typeof value !== "string" || !VALUES[field].includes(value)) {
      throw fault("INVALID_INTENT_ENUM", `${field} 的明确提交值不合法`);
    }
    return value;
  }
  function readIntentControls(dialog, prefix) {
    if (!dialog || typeof dialog.querySelector !== "function" || !["new", "project"].includes(prefix)) {
      throw fault("INTENT_DIALOG_INVALID", "缺少当前对话框或合法前缀");
    }
    const output = {};
    for (const field of Object.keys(VALUES)) {
      const element = dialog.querySelector(`#${prefix}${SUFFIX[field]}`);
      if (!element || String(element.tagName || "").toUpperCase() !== "SELECT") {
        throw fault("INTENT_CONTROL_MISSING", `缺少控件 ${field}`);
      }
      output[field] = validateIntent(field, String(element.value ?? ""));
    }
    return output;
  }
  return { VALUES, SUFFIX, validateIntent, readIntentControls };
});
