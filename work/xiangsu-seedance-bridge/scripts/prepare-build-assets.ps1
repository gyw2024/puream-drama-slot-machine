param(
  [string]$Destination
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $projectRoot "media-tools\ffmpeg.exe" }
$expectedSize = 87638016
$expectedHash = "2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3"
$downloadUrl = "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip"

function Test-ExpectedFfmpeg([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $FilePath
  if ($item.Length -ne $expectedSize) { return $false }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $FilePath).Hash -eq $expectedHash
}

if (Test-ExpectedFfmpeg $Destination) {
  Write-Host "FFmpeg 7.1 build asset is already present and verified."
  exit 0
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("puream-ffmpeg-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryRoot "ffmpeg-7.1-essentials_build.zip"
$expandedPath = Join-Path $temporaryRoot "expanded"
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  Write-Host "Downloading FFmpeg 7.1 essentials from the pinned GyanD GitHub release..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
  Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath -Force
  $candidate = Get-ChildItem -LiteralPath $expandedPath -Recurse -File -Filter "ffmpeg.exe" |
    Where-Object { $_.FullName -match "[\\/]bin[\\/]ffmpeg\.exe$" } |
    Select-Object -First 1
  if (-not $candidate) { throw "The downloaded archive does not contain bin\ffmpeg.exe" }
  if (-not (Test-ExpectedFfmpeg $candidate.FullName)) { throw "The downloaded ffmpeg.exe size or SHA-256 does not match" }
  $destinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $candidate.FullName -Destination $Destination -Force
  if (-not (Test-ExpectedFfmpeg $Destination)) { throw "FFmpeg verification failed after copying" }
  Write-Host "FFmpeg 7.1 build asset is ready: $Destination"
} catch {
  throw
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
