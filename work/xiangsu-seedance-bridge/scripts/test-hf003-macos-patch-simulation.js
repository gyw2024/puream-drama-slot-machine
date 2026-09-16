"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const patchRoot = path.resolve(process.env.HF003_PATCH_ROOT || path.join(root, "release-patches", "0.16.89-HF003"));
const baselineAsar = path.join(root, ".codex_backups", "TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003", "baseline", "installed", "resources", "app.asar");
const targetAsar = path.join(patchRoot, "macOS", "payload", "app.asar");
const manifest = JSON.parse(fs.readFileSync(path.join(patchRoot, "manifest.json"), "utf8"));
const taskRoot = path.join(root, ".codex_tests", "TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003");
const testRoot = fs.mkdtempSync(path.join(taskRoot, "macos-patch-simulation-"));
const fakeHome = path.join(testRoot, "home");
const fakeApp = path.join(testRoot, "Applications", "纯梦短剧老虎机.app");
const resources = path.join(fakeApp, "Contents", "Resources");
const mockBin = path.join(testRoot, "mock-bin");

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function posix(file) {
  const normalized = path.resolve(file).replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}
function writeExecutable(file, body) { fs.writeFileSync(file, body, "utf8"); fs.chmodSync(file, 0o755); }
function run(args, extraEnv = {}) {
  const result = spawnSync(bash, args, { cwd: patchRoot, encoding: "utf8", env: { ...process.env, HOME: posix(fakeHome), ...extraEnv } });
  if (result.status !== 0) throw new Error(`macOS patch simulation failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}
function runFailure(args, extraEnv = {}) {
  const result = spawnSync(bash, args, { cwd: patchRoot, encoding: "utf8", env: { ...process.env, HOME: posix(fakeHome), ...extraEnv } });
  if (result.status === 0) throw new Error(`macOS patch simulation unexpectedly succeeded:\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

fs.mkdirSync(resources, { recursive: true });
fs.mkdirSync(mockBin, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });
fs.copyFileSync(baselineAsar, path.join(resources, "app.asar"));
const plistPath = path.join(fakeApp, "Contents", "Info.plist");
fs.writeFileSync(plistPath, `bundleId=cn.puream.drama-slot-machine\nversion=0.16.89\nexecutable=纯梦短剧老虎机\nhash=${manifest.macOS.baselineAsarHeaderSha256}\n`, "utf8");
fs.writeFileSync(path.join(fakeApp, ".codesign-valid"), "valid\n", "utf8");

writeExecutable(path.join(mockBin, "plutil"), `#!/bin/bash\nkey="$2"\nfile="\${!#}"\ncase "$key" in\n  CFBundleIdentifier) grep '^bundleId=' "$file" | cut -d= -f2- ;;\n  CFBundleShortVersionString) grep '^version=' "$file" | cut -d= -f2- ;;\n  CFBundleExecutable) grep '^executable=' "$file" | cut -d= -f2- ;;\n  ElectronAsarIntegrity.Resources.app.asar.hash) grep '^hash=' "$file" | cut -d= -f2- ;;\nesac\n`);
writeExecutable(path.join(mockBin, "ditto"), `#!/bin/bash\ncp -R "$1" "$2"\n`);
writeExecutable(path.join(mockBin, "plistbuddy"), `#!/bin/bash\ncommand="$2"\nfile="\${!#}"\nif [[ "$command" == *':hash '* ]]; then value="\${command##* }"; sed -i "s/^hash=.*/hash=$value/" "$file"; fi\nexit 0\n`);
writeExecutable(path.join(mockBin, "codesign"), `#!/bin/bash\nbundle="\${!#}"\nif [[ " $* " == *' --verify '* ]]; then [[ -f "$bundle/.codesign-valid" ]]; else printf 'valid\\n' > "$bundle/.codesign-valid"; fi\n`);
writeExecutable(path.join(mockBin, "osascript"), "#!/bin/bash\nexit 0\n");
writeExecutable(path.join(mockBin, "pgrep"), "#!/bin/bash\nexit 1\n");
writeExecutable(path.join(mockBin, "pkill"), "#!/bin/bash\nexit 0\n");
writeExecutable(path.join(mockBin, "shasum"), "#!/bin/bash\nif [[ \"$1\" == \"-a\" ]]; then shift 2; fi\n/c/Program\\ Files/Git/usr/bin/sha256sum.exe \"$@\"\n");

const env = {
  PUREAM_DITTO_BIN: posix(path.join(mockBin, "ditto")),
  PUREAM_PLUTIL_BIN: posix(path.join(mockBin, "plutil")),
  PUREAM_PLIST_BUDDY: posix(path.join(mockBin, "plistbuddy")),
  PUREAM_CODESIGN_BIN: posix(path.join(mockBin, "codesign")),
  PUREAM_OSASCRIPT_BIN: posix(path.join(mockBin, "osascript")),
  PUREAM_PGREP_BIN: posix(path.join(mockBin, "pgrep")),
  PUREAM_PKILL_BIN: posix(path.join(mockBin, "pkill")),
  PUREAM_SHASUM_BIN: posix(path.join(mockBin, "shasum"))
};
const installScript = posix(path.join(patchRoot, "macOS", "install-macos.command"));
const rollbackScript = posix(path.join(patchRoot, "macOS", "rollback-macos.command"));
const appArgument = posix(fakeApp);

const invalidExplicitPathOutput = runFailure([installScript, posix(path.join(testRoot, "missing.app"))], env);
const installOutput = run([installScript, appArgument], env);
assert.equal(sha256(path.join(resources, "app.asar")), sha256(targetAsar));
assert.match(fs.readFileSync(plistPath, "utf8"), new RegExp(`hash=${manifest.payload.appAsar.headerSha256}`));
assert.equal(fs.existsSync(path.join(fakeApp, ".codesign-valid")), true);
fs.writeFileSync(plistPath, fs.readFileSync(plistPath, "utf8").replace(/^hash=.*$/m, "hash=broken"), "utf8");
fs.rmSync(path.join(fakeApp, ".codesign-valid"));
const repairOutput = run([installScript, appArgument], env);
assert.match(fs.readFileSync(plistPath, "utf8"), new RegExp(`hash=${manifest.payload.appAsar.headerSha256}`));
assert.equal(fs.existsSync(path.join(fakeApp, ".codesign-valid")), true);
const idempotentOutput = run([installScript, appArgument], env);
assert.match(idempotentOutput, /already installed/);
const backupApp = fs.readdirSync(path.join(fakeHome, "Library", "Application Support", "PUREAM", "drama-slot-patch-backups", "0.16.89-HF003"))
  .sort().reverse().map(name => path.join(fakeHome, "Library", "Application Support", "PUREAM", "drama-slot-patch-backups", "0.16.89-HF003", name, "app"))
  .find(candidate => fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")));
assert.ok(backupApp);
const backupAsar = path.join(backupApp, "Contents", "Resources", "app.asar");
fs.copyFileSync(targetAsar, backupAsar);
const badBackupOutput = runFailure([rollbackScript, appArgument], env);
assert.equal(sha256(path.join(resources, "app.asar")), sha256(targetAsar));
fs.copyFileSync(baselineAsar, backupAsar);
const rollbackOutput = run([rollbackScript, appArgument], env);
assert.equal(sha256(path.join(resources, "app.asar")), sha256(baselineAsar));
assert.match(fs.readFileSync(plistPath, "utf8"), new RegExp(`hash=${manifest.macOS.baselineAsarHeaderSha256}`));
assert.equal(fs.existsSync(path.join(fakeApp, ".codesign-valid")), true);
const secondRollbackOutput = run([rollbackScript, appArgument], env);
assert.match(secondRollbackOutput, /already at the original/);
const installedAsar = path.join(resources, "app.asar");
const unknownBytes = fs.readFileSync(installedAsar);
unknownBytes[unknownBytes.length - 1] ^= 1;
fs.writeFileSync(installedAsar, unknownBytes);
const unknownBefore = sha256(installedAsar);
const unknownBaselineOutput = runFailure([installScript, appArgument], env);
assert.equal(sha256(installedAsar), unknownBefore);
fs.copyFileSync(baselineAsar, installedAsar);

const result = {
  ok: true,
  testRoot,
  installOutput: installOutput.trim(),
  repairOutput: repairOutput.trim(),
  idempotentOutput: idempotentOutput.trim(),
  rollbackOutput: rollbackOutput.trim(),
  secondRollbackOutput: secondRollbackOutput.trim(),
  invalidExplicitPathRefused: /not found/.test(invalidExplicitPathOutput),
  badBackupRefused: /No hash-verified rollback backup/.test(badBackupOutput),
  unknownBaselineRefused: /accepts only the registered/.test(unknownBaselineOutput),
  baselineAsarSha256: sha256(baselineAsar),
  targetAsarSha256: sha256(targetAsar),
  realMacVerified: false
};
fs.writeFileSync(path.join(testRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
