#!/bin/bash
set -euo pipefail

BASE_ASAR_SHA256="08d9e669fde66f39fb027a6ae81e794b05c438087499b28a0976bf816d338779"
BASE_ASAR_HEADER_SHA256="64a2a997480e07146d03f6eabdf01d2913d1a6279c8ad31ae4dbea03c2d8867e"
TARGET_ASAR_SHA256="26233820215195014b0d925c14a56472f2f4206db42b7e866df91ffae704dedc"
TARGET_ASAR_HEADER_SHA256="df8140e390afa1cc9d47b4c670648adbebbbb4f0e180ade9e0efcb6dda50eeb9"
CI_INPUT="$GITHUB_WORKSPACE/.codex-ci/HF003"
WORK="$RUNNER_TEMP/puream-hf003-${RUNNER_ARCH}"
PATCH_ROOT="$WORK/patch"
APP="$WORK/Applications/纯梦短剧老虎机.app"
BASELINE_ASAR="$CI_INPUT/baseline-app.asar"
INFO_PLIST="$APP/Contents/Info.plist"

sha256_file() { shasum -a 256 "$1" | awk '{print tolower($1)}'; }

wait_for_gateway() {
  local label="$1"
  local user_data="$WORK/userdata-$label"
  local log="$WORK/$label.log"
  mkdir -p "$user_data"
  PUREAM_HEADLESS_MCP=1 "$APP/Contents/MacOS/Electron" "--user-data-dir=$user_data" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do
    if [[ -f "$user_data/mcp-control.json" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      cat "$log" >&2 || true
      return 1
    fi
    sleep 0.5
  done
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
  cat "$log" >&2 || true
  echo "$label did not create the headless control gateway" >&2
  return 1
}

rm -rf "$WORK"
mkdir -p "$PATCH_ROOT" "$WORK/Applications" "$WORK/npm"
unzip -q "$CI_INPUT/patch.zip" -d "$PATCH_ROOT"

pushd "$WORK/npm" >/dev/null
npm init -y >/dev/null
npm install --no-audit --no-fund electron@43.2.0 @electron/fuses@2.0.0 >/dev/null
popd >/dev/null

ditto "$WORK/npm/node_modules/electron/dist/Electron.app" "$APP"
cp "$BASELINE_ASAR" "$APP/Contents/Resources/app.asar"
[[ "$(sha256_file "$APP/Contents/Resources/app.asar")" == "$BASE_ASAR_SHA256" ]]

/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier cn.puream.drama-slot-machine" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.16.89" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$INFO_PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity dict" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity:Resources/app.asar dict" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity:Resources/app.asar:hash string $BASE_ASAR_HEADER_SHA256" "$INFO_PLIST"

APP_EXECUTABLE="$APP/Contents/MacOS/Electron" node - <<'NODE'
const { flipFuses, FuseVersion, FuseV1Options } = require(process.env.RUNNER_TEMP + `/puream-hf003-${process.env.RUNNER_ARCH}/npm/node_modules/@electron/fuses`);
flipFuses(process.env.APP_EXECUTABLE, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: process.arch === "arm64",
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
}).catch(error => { console.error(error); process.exit(1); });
NODE
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
wait_for_gateway baseline

bash "$PATCH_ROOT/macOS/install-macos.command" "$APP"
[[ "$(sha256_file "$APP/Contents/Resources/app.asar")" == "$TARGET_ASAR_SHA256" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$INFO_PLIST")" == "$TARGET_ASAR_HEADER_SHA256" ]]
codesign --verify --deep --strict --verbose=2 "$APP"

# Simulate interruption after the target ASAR was written but before plist and
# signing completed. A second run must repair, not report a false idempotent hit.
/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash broken" "$INFO_PLIST"
codesign --remove-signature "$APP"
bash "$PATCH_ROOT/macOS/install-macos.command" "$APP"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$INFO_PLIST")" == "$TARGET_ASAR_HEADER_SHA256" ]]
codesign --verify --deep --strict --verbose=2 "$APP"
bash "$PATCH_ROOT/macOS/install-macos.command" "$APP" | grep -q "already installed and verified"
wait_for_gateway patched

BACKUP_APP="$(find "$HOME/Library/Application Support/PUREAM/drama-slot-patch-backups/0.16.89-HF003" -mindepth 2 -maxdepth 2 -type d -name app | sort -r | head -n 1)"
[[ -n "$BACKUP_APP" ]]
cp "$PATCH_ROOT/macOS/payload/app.asar" "$BACKUP_APP/Contents/Resources/app.asar"
if bash "$PATCH_ROOT/macOS/rollback-macos.command" "$APP"; then echo "corrupt backup was accepted" >&2; exit 1; fi
[[ "$(sha256_file "$APP/Contents/Resources/app.asar")" == "$TARGET_ASAR_SHA256" ]]
cp "$BASELINE_ASAR" "$BACKUP_APP/Contents/Resources/app.asar"
codesign --force --deep --sign - "$BACKUP_APP"
codesign --verify --deep --strict --verbose=2 "$BACKUP_APP"
bash "$PATCH_ROOT/macOS/rollback-macos.command" "$APP"
[[ "$(sha256_file "$APP/Contents/Resources/app.asar")" == "$BASE_ASAR_SHA256" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$INFO_PLIST")" == "$BASE_ASAR_HEADER_SHA256" ]]
codesign --verify --deep --strict --verbose=2 "$APP"
bash "$PATCH_ROOT/macOS/rollback-macos.command" "$APP" | grep -q "already at the original"
wait_for_gateway rollback

printf '\0' >> "$APP/Contents/Resources/app.asar"
UNKNOWN_SHA="$(sha256_file "$APP/Contents/Resources/app.asar")"
if bash "$PATCH_ROOT/macOS/install-macos.command" "$APP"; then echo "unknown baseline was accepted" >&2; exit 1; fi
[[ "$(sha256_file "$APP/Contents/Resources/app.asar")" == "$UNKNOWN_SHA" ]]

printf '{"ok":true,"runner":"%s","arch":"%s","os":"%s","targetAsar":"%s"}\n' \
  "$RUNNER_NAME" "$(uname -m)" "$(sw_vers -productVersion)" "$TARGET_ASAR_SHA256" | tee "$WORK/result.json"
