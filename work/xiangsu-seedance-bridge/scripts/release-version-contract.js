"use strict";
const fs = require("node:fs");
const path = require("node:path");

function expectedOutput(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error("发布版本必须是三段数字版本号");
  return `dist-fixed-${version}`;
}
function verifyReleaseVersion(pkg, lock) {
  const output = expectedOutput(pkg.version);
  if (pkg.build?.directories?.output !== output) throw new Error(`发布目录与版本不一致：应为 ${output}。请通过 npm version 升版，不要用命令行覆盖目录掩盖配置错误。`);
  if (lock?.version !== pkg.version || lock?.packages?.[""]?.version !== pkg.version) throw new Error("package-lock 发布版本与 package.json 不一致");
  return { version: pkg.version, output, lockVersion: lock.version };
}
function syncReleaseVersion(root) {
  const file = path.join(root,"package.json");
  const pkg = JSON.parse(fs.readFileSync(file,"utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
  // npm's version lifecycle has already updated both version fields. Fail
  // rather than silently rewriting an unrelated or stale dependency lockfile.
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error("请先让 npm 同步 package 与 lockfile 版本");
  pkg.build.directories.output = expectedOutput(pkg.version);
  fs.writeFileSync(file, `${JSON.stringify(pkg,null,2)}\n`, "utf8");
  return verifyReleaseVersion(pkg,lock);
}
if (require.main === module) {
  const root=path.resolve(__dirname,"..");
  const result=process.argv.includes("--sync") ? syncReleaseVersion(root) : verifyReleaseVersion(require(path.join(root,"package.json")),require(path.join(root,"package-lock.json")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
module.exports={expectedOutput,verifyReleaseVersion,syncReleaseVersion};
