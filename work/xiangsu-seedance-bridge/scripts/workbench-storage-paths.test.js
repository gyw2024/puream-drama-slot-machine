"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { defaultWorkbenchRoot, resolveWorkbenchRoot, stagingRootForWorkbench } = require("../app/workbench-storage-paths");
const userData = "C:\\Users\\tester\\AppData\\Roaming\\xiangsu-seedance-bridge";
const target = "D:\\projects\\drama\\运行数据\\user-data\\workbench";
function options(config, present = ["D:\\", "C:\\"], env = {}) {
  return { platform: "win32", env, exists: file => present.includes(file) || (file.endsWith("storage-location.json") && config !== undefined), read: () => config };
}
test("new Windows installs with D available store workbench assets on D", () => {
  assert.equal(defaultWorkbenchRoot(userData, options(undefined)), "D:\\PUREAM\\纯梦短剧老虎机数据");
});
test("an existing C workbench is never abandoned by the new default", () => {
  const old = path.win32.join(userData, "workbench");
  assert.equal(defaultWorkbenchRoot(userData, options(undefined, [old, "C:\\", "D:\\"])), old);
});
test("saved project storage remains the default even when legacy paths exist", () => {
  assert.equal(resolveWorkbenchRoot(userData, options(JSON.stringify({workbenchDataRoot: target}), [target, "C:\\", "D:\\", path.win32.join(userData,"workbench")])), target);
});
test("a missing D volume never creates an empty C workbench", () => {
  assert.throws(() => resolveWorkbenchRoot(userData, options(JSON.stringify({workbenchDataRoot: target}), ["C:\\"])), {code:"STORAGE_LOCATION_UNAVAILABLE"});
});
test("a missing saved directory also fails when its drive is still present", () => {
  assert.throws(() => resolveWorkbenchRoot(userData, options(JSON.stringify({workbenchDataRoot: target}))), {code:"STORAGE_LOCATION_UNAVAILABLE"});
});
test("corrupt and relative saved locations fail without falling back", () => {
  for (const config of ["{broken", "{}", JSON.stringify({workbenchDataRoot:"relative/data"}), JSON.stringify({workbenchDataRoot:"\\drive-relative"})]) assert.throws(() => resolveWorkbenchRoot(userData, options(config)), {code:"STORAGE_LOCATION_CONFIG_INVALID"});
});
test("explicit runtime root retains precedence and must be absolute", () => {
  assert.equal(resolveWorkbenchRoot(userData, options("broken", ["D:\\"], {DRAMA_SLOT_DATA_ROOT:target})), target);
  assert.throws(() => resolveWorkbenchRoot(userData, options(undefined, [], {DRAMA_SLOT_DATA_ROOT:"relative"})), {code:"STORAGE_LOCATION_CONFIG_INVALID"});
});
test("both mode staging roots are within the configured persistent data root", () => {
  const root = path.resolve("storage-test-root");
  for (const scope of ["workbench", "simple"]) assert.equal(stagingRootForWorkbench(root, scope), path.join(root,".staging",scope));
  assert.throws(() => stagingRootForWorkbench(root,"../escape"), {code:"STORAGE_SCOPE_INVALID"});
});
test("machines without D and non-Windows installs keep their local fallback", () => {
  assert.equal(defaultWorkbenchRoot(userData, options(undefined, ["C:\\"])), path.win32.join(userData,"workbench"));
  assert.equal(defaultWorkbenchRoot("/home/tester/.drama", {platform:"linux",exists:()=>false}), "/home/tester/.drama/workbench");
});
