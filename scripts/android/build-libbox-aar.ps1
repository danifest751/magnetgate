#Requires -Version 5.1
<#
.SYNOPSIS
  Builds libbox.aar (the in-process engine) from the sing-box source pinned in scripts/pins.json.

.DESCRIPTION
  Upstream publishes no libbox AAR, so the app's engine is built here from a pinned tag AND commit: a
  moved tag stops the build instead of silently changing what runs inside the app. The Go build tags and
  linker flags mirror cmd/internal/build_libbox/main.go at that commit, and sing-box's own gomobile fork
  is used because that is what its build script uses.

  The output is a build artifact (app-android/libs/ is not committed), so this script is the pin.

.EXAMPLE
  powershell -File scripts/android/build-libbox-aar.ps1
  powershell -File scripts/android/build-libbox-aar.ps1 -CheckoutOnly
#>
[CmdletBinding()]
param(
  [string[]]$Targets = @('android/arm64', 'android/amd64'),
  [int]$AndroidApi = 26,
  [string]$Go = '',
  [string]$Output = '',
  [switch]$CheckoutOnly
)

Continue = 'Stop'
. (Join-Path $PSScriptRoot 'aar-tools.ps1')

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pins = Get-Content -LiteralPath (Join-Path $root 'scripts\pins.json') -Raw | ConvertFrom-Json
$pin = $pins.singBoxSource
if (-not $pin) { throw 'scripts/pins.json has no singBoxSource entry' }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$ndk = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else {
  $dir = Join-Path $sdk 'ndk'
  if (-not (Test-Path -LiteralPath $dir)) { throw "no NDK under $dir and ANDROID_NDK_HOME is not set" }
  Get-ChildItem -LiteralPath $dir -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path (Split-Path -Parent $sdk) 'jdk17' }
if (-not (Test-Path -LiteralPath (Join-Path $jdk 'bin\java.exe'))) { throw "no JDK found (JAVA_HOME=$jdk); libbox needs JDK 17" }
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }
$goBin = Split-Path -Parent (Get-Command $goExe -ErrorAction Stop).Source

# 1. the pinned source, checked out at the pinned commit
$source = Join-Path $root 'tools\sing-box-src'
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
  Write-Host "[source] cloning $($pin.url) (tag $($pin.tag))"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
  Invoke-Native 'git' @('clone', '--filter=blob:none', '--branch', $pin.tag, $pin.url, $source) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
} else {
  Invoke-Native 'git' @('-C', $source, 'fetch', '--depth', '1', 'origin', $pin.tag) | Out-Null
}
Invoke-Native 'git' @('-C', $source, 'checkout', '--detach', $pin.commit) | Out-Null
if ($LASTEXITCODE -ne 0) { throw "cannot check out the pinned commit $($pin.commit)" }
$head = ((Invoke-Native 'git' @('-C', $source, 'rev-parse', 'HEAD')) -join '').Trim()
if ($head -ne $pin.commit) {
  throw "sing-box is at $head but scripts/pins.json pins $($pin.commit): the tag moved, decide deliberately"
}
Write-Host "[source] $($pin.tag) at $head"

if ($CheckoutOnly) { exit 0 }

# 2. sing-box's own gomobile fork, shared with the core's AAR build so both bindings ship the same
#    go.Seq support classes (two different toolchains would make them incompatible)
$gomobile = Get-GomobileSagernet -Pins $pins -Sdk $sdk -GoExe $goExe
$gomobileBin = Split-Path -Parent $gomobile

if (-not $Output) { $Output = Join-Path $root 'app-android\libs\libbox.aar' }
$outputDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }

$env:PATH = "$goBin;$gomobileBin;$env:PATH"
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_NDK_HOME = $ndk

# 3. the flags cmd/internal/build_libbox/main.go uses at this commit
$tags = @(
  'with_gvisor', 'with_quic', 'with_wireguard', 'with_utls', 'with_naive_outbound', 'with_clash_api',
  'with_usbip', 'with_openvpn', 'with_openconnect', 'badlinkname', 'tfogo_checklinkname0',
  'with_tailscale', 'ts_omit_logtail', 'ts_omit_ssh', 'ts_omit_drive', 'ts_omit_taildrop',
  'ts_omit_webclient', 'ts_omit_doctor', 'ts_omit_capture', 'ts_omit_kube', 'ts_omit_aws',
  'ts_omit_synology', 'ts_omit_bird', 'with_low_memory'
) -join ','
$ldflags = "-X github.com/sagernet/sing-box/constant.Version=$($pin.tag) " +
  '-X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid='

$target = $Targets -join ','
Write-Host "[bind] libbox $target (api $AndroidApi) -> $Output"
Invoke-Native $gomobile @(
  'bind', '-o', $Output, '-target', $target, '-androidapi', $AndroidApi,
  '-javapkg=io.nekohasekai', '-libname=box', '-trimpath', '-buildvcs=false',
  '-ldflags', $ldflags, '-tags', $tags, './experimental/libbox'
) $source
if ($LASTEXITCODE -ne 0) { throw 'gomobile bind failed for libbox' }

$built = Get-Item -LiteralPath $Output
Write-Host ("[ok] {0} ({1:N0} bytes)" -f $built.Name, $built.Length)
