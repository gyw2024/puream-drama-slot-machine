"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {verifyReleaseVersion,expectedOutput}=require("./release-version-contract");
const pkg={version:"0.16.178",build:{directories:{output:"dist-fixed-0.16.178"}}};
const lock={version:pkg.version,packages:{"":{version:pkg.version}}};
test("release preflight rejects the exact stale output directory incident",()=>{
  assert.throws(()=>verifyReleaseVersion({...pkg,build:{directories:{output:"dist-fixed-0.16.176"}}},lock),/发布目录与版本不一致/);
  assert.equal(verifyReleaseVersion(pkg,lock).output,"dist-fixed-0.16.178");
});
test("release preflight rejects stale lock metadata and unsafe output versions",()=>{
  assert.throws(()=>verifyReleaseVersion(pkg,{...lock,version:"0.16.177"}),/package-lock/);
  assert.throws(()=>verifyReleaseVersion(pkg,{...lock,packages:{"":{version:"0.16.177"}}}),/package-lock/);
  assert.throws(()=>expectedOutput("../../unsafe"),/版本号/);
});
test("npm version synchronizes output and every build runs verification first",()=>{
  const current=require("../package.json");
  assert.equal(current.scripts.version,"node scripts/release-version-contract.js --sync");
  for(const name of ["prebuild:dir","prebuild:installer"])assert.match(current.scripts[name],/verify:build-assets/);
  const preflight=fs.readFileSync(path.join(__dirname,"verify-build-assets.js"),"utf8");
  assert.match(preflight,/verifyReleaseVersion/);
  verifyReleaseVersion(current,require("../package-lock.json"));
});
