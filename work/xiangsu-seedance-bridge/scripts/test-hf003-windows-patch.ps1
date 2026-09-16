$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$taskRoot = Join-Path $root ".codex_tests\TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003"
$testLabel = if ($env:HF003_TEST_LABEL) { $env:HF003_TEST_LABEL } else { "windows-patch-" + (Get-Date -Format "yyyyMMdd-HHmmss") }
$testRoot = Join-Path $taskRoot $testLabel
if (Test-Path -LiteralPath $testRoot) { throw "Test output already exists: $testRoot" }
$appDir = Join-Path $testRoot "app"
$localData = Join-Path $testRoot "localappdata"
$userData = Join-Path $testRoot "userdata"
New-Item -ItemType Directory -Path $appDir, $localData, $userData -Force | Out-Null

$buildDir = Join-Path $root "dist-fixed-0.16.89\win-unpacked"
$copy = Start-Process -FilePath "robocopy.exe" -ArgumentList @($buildDir, $appDir, "/E", "/COPY:DAT", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS") -Wait -PassThru -WindowStyle Hidden
if ($copy.ExitCode -gt 7) { throw "robocopy failed: $($copy.ExitCode)" }

$baselineDir = Join-Path $root ".codex_backups\TASK-20260823-DRAMA-PARTIAL-TOPICS-PATCH-003\baseline\installed"
$mainExe = Get-ChildItem -LiteralPath $appDir -Filter "*.exe" -File | Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1
$baselineExe = Get-ChildItem -LiteralPath $baselineDir -Filter "*.exe" -File | Select-Object -First 1
if (-not $mainExe -or -not $baselineExe) { throw "test executable not found" }
Copy-Item -LiteralPath $baselineExe.FullName -Destination $mainExe.FullName -Force
Copy-Item -LiteralPath (Join-Path $baselineDir "resources\app.asar") -Destination (Join-Path $appDir "resources\app.asar") -Force

$previousLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $localData
$patchRoot = if ($env:HF003_PATCH_ROOT) { [IO.Path]::GetFullPath($env:HF003_PATCH_ROOT) } else { Join-Path $root "release-patches\0.16.89-HF003" }
$patchScript = Join-Path $patchRoot "Windows\install-windows.ps1"
$expectedTargetExe = "38E1A85EE20B17FA521DD0BE99532E5670F6A6CB79A09A1B5664B0E5EDF4131E"
$expectedTargetAsar = "26233820215195014B0D925C14A56472F2F4206DB42B7E866DF91FFAE704DEDC"
$expectedBaselineExe = "F17605D89E694D7DB51A9DD5CF9E49E7656E0975D698697AC03B52504B05F98F"
$expectedBaselineAsar = "08D9E669FDE66F39FB027A6AE81E794B05C438087499B28A0976BF816D338779"
function Invoke-PatchExpectFailure([string[]]$PatchArgs) {
  $ErrorActionPreference = "Continue"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchScript @PatchArgs 2>$null
  return $LASTEXITCODE
}
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchScript -InstallDir $appDir
  if ($LASTEXITCODE -ne 0) { throw "patch install failed: $LASTEXITCODE" }
  $firstExe = (Get-FileHash -LiteralPath $mainExe.FullName -Algorithm SHA256).Hash
  $firstAsar = (Get-FileHash -LiteralPath (Join-Path $appDir "resources\app.asar") -Algorithm SHA256).Hash
  if ($firstExe -ne $expectedTargetExe -or $firstAsar -ne $expectedTargetAsar) { throw "patched hash assertion failed" }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchScript -InstallDir $appDir
  if ($LASTEXITCODE -ne 0) { throw "idempotent install failed: $LASTEXITCODE" }
  if ((Get-FileHash -LiteralPath $mainExe.FullName -Algorithm SHA256).Hash -ne $expectedTargetExe) { throw "idempotent EXE hash changed" }
  if ((Get-FileHash -LiteralPath (Join-Path $appDir "resources\app.asar") -Algorithm SHA256).Hash -ne $expectedTargetAsar) { throw "idempotent ASAR hash changed" }

  $env:PUREAM_HEADLESS_MCP = "1"
  $process = Start-Process -FilePath $mainExe.FullName -ArgumentList @("--user-data-dir=$userData") -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 4
  $alive = -not $process.HasExited
  $gateway = Test-Path -LiteralPath (Join-Path $userData "mcp-control.json")
  if ($alive) { Stop-Process -Id $process.Id -Force }
  Remove-Item Env:PUREAM_HEADLESS_MCP -ErrorAction SilentlyContinue
  if (-not $alive -or -not $gateway) { throw "patched headless runtime assertion failed" }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchScript -InstallDir $appDir -Rollback
  if ($LASTEXITCODE -ne 0) { throw "rollback failed: $LASTEXITCODE" }
  $rollbackExe = (Get-FileHash -LiteralPath $mainExe.FullName -Algorithm SHA256).Hash
  $rollbackAsar = (Get-FileHash -LiteralPath (Join-Path $appDir "resources\app.asar") -Algorithm SHA256).Hash
  if ($rollbackExe -ne $expectedBaselineExe -or $rollbackAsar -ne $expectedBaselineAsar) { throw "rollback hash assertion failed" }

  $invalidDir = Join-Path $testRoot "explicit-path-does-not-exist"
  $invalidExit = Invoke-PatchExpectFailure @("-InstallDir", $invalidDir)
  if ($invalidExit -eq 0) { throw "invalid explicit path unexpectedly fell back to another installation" }

  $asarPath = Join-Path $appDir "resources\app.asar"
  $stream = [IO.File]::Open($asarPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    [void]$stream.Seek(-1, [IO.SeekOrigin]::End)
    $last = $stream.ReadByte()
    [void]$stream.Seek(-1, [IO.SeekOrigin]::End)
    $stream.WriteByte(($last -bxor 1))
  } finally { $stream.Dispose() }
  $unknownBefore = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
  $unknownExit = Invoke-PatchExpectFailure @("-InstallDir", $appDir)
  if ($unknownExit -eq 0) { throw "unknown baseline was unexpectedly accepted" }
  $unknownAfter = (Get-FileHash -LiteralPath $asarPath -Algorithm SHA256).Hash
  if ($unknownAfter -ne $unknownBefore -or (Get-FileHash -LiteralPath $mainExe.FullName -Algorithm SHA256).Hash -ne $expectedBaselineExe) { throw "unknown baseline was modified" }
  Copy-Item -LiteralPath (Join-Path $baselineDir "resources\app.asar") -Destination $asarPath -Force

  $result = [ordered]@{
    testRoot = $testRoot
    patchedExe = $firstExe
    patchedAsar = $firstAsar
    headlessAlive = $alive
    gatewayCreated = $gateway
    rollbackExe = $rollbackExe
    rollbackAsar = $rollbackAsar
    invalidExplicitPathRefused = $true
    unknownBaselineRefused = $true
  }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot "result.json") -Encoding UTF8
  $result | ConvertTo-Json
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  Remove-Item Env:PUREAM_HEADLESS_MCP -ErrorAction SilentlyContinue
}
