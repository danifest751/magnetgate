#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the Go core into an Android library (AAR) the app links against.

.DESCRIPTION
  The app runs the core in its own process - that is what lets the core's sockets be kept out of the
  tunnel the app itself creates - so `golang.org/x/mobile/cmd/gobind` is recorded as a tool dependency in
  app-android/core/go.mod and the binding is built here rather than by hand.

  The AAR is a build artifact and is not committed: this script is the pin, and it is what the app build
  depends on. Rebuild it after any change under app-android/core.

.EXAMPLE
  powershell -File scripts/android/build-core-aar.ps1
  powershell -File scripts/android/build-core-aar.ps1 -Abis android/arm64
#>
[CmdletBinding()]
param(
  [string[]]$Targets = @('android/arm64', 'android/amd64'),
  [int]$AndroidApi = 26,
  [string]$Go = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core = Join-Path $root 'app-android\core'
if (-not (Test-Path -LiteralPath $core)) { throw "core not found under $core" }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$ndk = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else {
  $dir = Join-Path $sdk 'ndk'
  if (-not (Test-Path -LiteralPath $dir)) { throw "no NDK under $dir and ANDROID_NDK_HOME is not set" }
  Get-ChildItem -LiteralPath $dir -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }
$goBin = Split-Path -Parent (Get-Command $goExe -ErrorAction Stop).Source
$gopath = (& $goExe env GOPATH).Trim()
$gomobile = Join-Path $gopath 'bin\gomobile.exe'
if (-not (Test-Path -LiteralPath $gomobile)) { $gomobile = Join-Path $gopath 'bin\gomobile' }
if (-not (Test-Path -LiteralPath $gomobile)) {
  throw "gomobile not found in $gopath\bin - install it with: go install golang.org/x/mobile/cmd/gomobile@latest"
}
if (-not $Output) { $Output = Join-Path $root 'app-android\libs\magnetgate.aar' }
$outputDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }

# gomobile shells out to go and to gobind; gobind lives next to gomobile and is built by `gomobile init`
$env:PATH = "$goBin;$gopath\bin;$env:PATH"
$env:ANDROID_HOME = $sdk
$env:ANDROID_NDK_HOME = $ndk

if (-not (Test-Path -LiteralPath (Join-Path $gopath 'bin\gobind.exe')) -and -not (Test-Path -LiteralPath (Join-Path $gopath 'bin\gobind'))) {
  Write-Host '[gomobile] init'
  Push-Location $core
  try { & $gomobile init } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'gomobile init failed' }
}

$target = $Targets -join ','
Write-Host "[bind] $target (api $AndroidApi) -> $Output"
Push-Location $core
try {
  & $gomobile bind "-target=$target" '-androidapi' $AndroidApi '-o' $Output './mobile'
  if ($LASTEXITCODE -ne 0) { throw 'gomobile bind failed' }
} finally {
  Pop-Location
}

$built = Get-Item -LiteralPath $Output
Write-Host ("[ok] {0} ({1:N0} bytes)" -f $built.Name, $built.Length)
