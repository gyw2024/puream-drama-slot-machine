"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("project toolbar uses complete action labels instead of ambiguous single characters", () => {
  const workbench = read("app/renderer/workbench.html");
  const simple = read("app/renderer/simple-mode.html");
  assert.doesNotMatch(workbench, />\s*(?:包|删|恢)\s*<\/button>/u);
  assert.doesNotMatch(simple, />\s*(?:包|删|恢)\s*<\/button>/u);
  assert.match(workbench, /<b>导入资产包<\/b>/u);
  assert.match(workbench, /<b>删除项目<\/b>/u);
  assert.match(workbench, /<b>恢复项目<\/b>/u);
});

test("background refresh skips hidden windows and reloads large projects only on meaningful state changes", () => {
  const renderer = read("app/renderer/workbench.js");
  assert.match(renderer, /if \(document\.hidden\) return;/);
  assert.match(renderer, /videoJobsChanged \|\| scriptNeedsRefresh \|\| pipelineNeedsRefresh/);
  assert.match(renderer, /recoverableFailure === true;/);
  assert.match(renderer, /autoResume: state\.project\?\.automation\?\.autoResume===true/);
  assert.match(renderer, /showToast\(recoveryMessage, "warning"\)/);
});
