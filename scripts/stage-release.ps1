# ============================================================
# stage-release.ps1  -  Generate release artifacts for the updater:
#   * extract resources/app.asar from the packaged app dir
#   * compute sha512
#   * write latest.json (version + file name + hash + size)
#   * copy the asar into _release/ for upload as a GitHub Release asset
# Usage:
#   pwsh -File scripts/stage-release.ps1 [-Version 1.11.0] [-ReleaseNotes "..."]
# ============================================================
param(
  [string]$Version = "",
  [string]$ReleaseNotes = "",
  [string]$AppDir = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $AppDir) { $AppDir = Join-Path $root 'dist\Workstation-win32-x64' }
$asar = Join-Path $AppDir 'resources\app.asar'
if (-not (Test-Path $asar)) {
  Write-Output ("ERROR: cannot find " + $asar + " . Run npm run pack first.")
  exit 1
}

if (-not $Version) {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
$Version = [string]$Version
$Version = $Version.TrimStart('v')

$sha = (Get-FileHash $asar -Algorithm SHA512).Hash.ToLower()
$size = (Get-Item $asar).Length
$fileName = "workstation-" + $Version + ".asar"

$relDir = Join-Path $root '_release'
New-Item -ItemType Directory -Force -Path $relDir | Out-Null
Copy-Item $asar (Join-Path $relDir $fileName) -Force

$fileObj = @{ name = $fileName; platform = 'win32-x64'; sha512 = $sha; size = $size }
$man = @{
  version    = $Version
  releasedAt = (Get-Date -Format o)
  notes      = $ReleaseNotes
  files      = @($fileObj)
}
$man | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $relDir 'latest.json') -Encoding UTF8

Write-Output ("OK: latest.json -> " + (Join-Path $relDir 'latest.json'))
Write-Output ("OK: asar -> " + (Join-Path $relDir $fileName))
Write-Output ("size = " + $size + " bytes")
Write-Output ("sha512 = " + $sha)
