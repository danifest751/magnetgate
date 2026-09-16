#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the Go core into an Android library (AAR) the app links against.

.DESCRIPTION
  The app runs the core in its own process - that is what lets the core's sockets be kept out of the
  tunnel the app itself creates - so `golang.org/x/mobile/cmd/gobind` is recorded as a tool dependency in
  app-android/core/go.mod and the binding is built here rather than by hand.

  Two details are not obvious:
    * the build uses the same gomobile fork as libbox (see scripts/pins.json), because two gomobile
      bindings built with different toolchains would ship incompatible go.Seq classes;
    * the go.* support classes are stripped from this AAR afterwards, because libbox's copy is the one the
      app keeps - otherwise the app fails to build with "Duplicate class go.Seq".

  The AAR is a build artifact and is not committed: this script is the pin, and it is what the app build
  depends on. Rebuild it after any change under app-android/core.

.EXAMPLE
  powershell -File scripts/android/build-core-aar.ps1
  powershell -File scripts/android/build-core-aar.ps1 -Targets android/arm64
#>
[CmdletBinding()]
param(
  [string[]]$Targets = @('android/arm64', 'android/amd64'),
  [int]$AndroidApi = 26,
  [string]$Go = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aar-tools.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core = Join-Path $root 'app-android\core'
if (-not (Test-Path -LiteralPath $core)) { throw "core not found under $core" }
$pins = Get-Content -LiteralPath (Join-Path $root 'scripts\pins.json') -Raw | ConvertFrom-Json

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$ndk = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else {
  $dir = Join-Path $sdk 'ndk'
  if (-not (Test-Path -LiteralPath $dir)) { throw "no NDK under $dir and ANDROID_NDK_HOME is not set" }
  Get-ChildItem -LiteralPath $dir -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }
$goBin = Split-Path -Parent (Get-Command $goExe -ErrorAction Stop).Source
$gomobile = Get-GomobileSagernet -Pins $pins -Sdk $sdk -GoExe $goExe

if (-not $Output) { $Output = Join-Path $root 'app-android\libs\magnetgate.aar' }
$outputDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }

$env:PATH = "$goBin;$(Split-Path -Parent $gomobile);$env:PATH"
$env:ANDROID_HOME = $sdk
$env:ANDROID_NDK_HOME = $ndk

$target = $Targets -join ','
Write-Host "[bind] core $target (api $AndroidApi) -> $Output"
Push-Location $core
try {
  Invoke-Native $gomobile @('bind', "-target=$target", '-androidapi', $AndroidApi, '-o', $Output, './mobile')
  if ($LASTEXITCODE -ne 0) { throw 'gomobile bind failed for the core' }
} finally {
  Pop-Location
}

Remove-AarClasses -Aar $Output -JarEntry 'classes.jar' -Prefix 'go/'
$built = Get-Item -LiteralPath $Output
Write-Host ("[ok] {0} ({1:N0} bytes, go.* support classes stripped)" -f $built.Name, $built.Length)
