#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the app's single native binding: the core and the sing-box engine in one AAR.

.DESCRIPTION
  The app must not hold two gomobile bindings: that would be two Go runtimes in one process, and the
  engine's callbacks into Java do not survive that (the runtime aborts with "unexpected return pc for
  runtime.cgocallback"). app-android/engine/mgbox is therefore the one package that exposes both halves,
  and this script builds it.

  The engine comes from the sing-box version pinned in scripts/pins.json, fetched through the Go module
  proxy; the script also checks that the version still resolves to the commit pinned next to it, so a
  moved tag stops the build instead of silently changing what runs inside the app. The Go build tags and
  linker flags are the ones cmd/internal/build_libbox/main.go uses at that commit, and sing-box's own
  gomobile fork is used because that is what its build script uses.

  The AAR is a build artifact (app-android/libs is not committed): this script is the pin.

.EXAMPLE
  powershell -File scripts/android/build-aar.ps1
  powershell -File scripts/android/build-aar.ps1 -Targets android/arm64
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
$engine = Join-Path $root 'app-android\engine'
if (-not (Test-Path -LiteralPath $engine)) { throw "the engine module is missing under $engine" }
$pins = Get-Content -LiteralPath (Join-Path $root 'scripts\pins.json') -Raw | ConvertFrom-Json
$pin = $pins.singBoxSource
if (-not $pin) { throw 'scripts/pins.json has no singBoxSource entry' }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$ndk = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else {
  $dir = Join-Path $sdk 'ndk'
  if (-not (Test-Path -LiteralPath $dir)) { throw "no NDK under $dir and ANDROID_NDK_HOME is not set" }
  Get-ChildItem -LiteralPath $dir -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }
$goBin = Split-Path -Parent (Get-Command $goExe -ErrorAction Stop).Source
$gomobile = Get-GomobileSagernet -Pins $pins -Sdk $sdk -GoExe $goExe
$gomobileBin = Split-Path -Parent $gomobile

# the version must still resolve to the pinned commit
$module = "$($pin.url -replace '\.git$', '' -replace '^https://', '')@$($pin.tag)"
$resolved = (& $goExe list -m -json $module 2>&1 | Out-String)
$hash = ([regex]::Match($resolved, '"Hash":\s*"([0-9a-f]+)"')).Groups[1].Value
if ($hash -ne $pin.commit) {
  throw "sing-box $($pin.tag) resolves to $hash but scripts/pins.json pins $($pin.commit): decide deliberately"
}
Write-Host "[source] sing-box $($pin.tag) at $hash"

if (-not $Output) { $Output = Join-Path $root 'app-android\libs\mgcore.aar' }
$outputDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }

$env:PATH = "$goBin;$gomobileBin;$env:PATH"
$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path (Split-Path -Parent $sdk) 'jdk17' }
$env:ANDROID_HOME = $sdk
$env:ANDROID_NDK_HOME = $ndk
$env:GOWORK = 'off' # the module's own go.mod decides the engine version, not a workspace file

# cmd/internal/build_libbox/main.go at the pinned commit
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
Write-Host "[bind] core + engine $target (api $AndroidApi) -> $Output"
Invoke-Native $gomobile @(
  'bind', '-o', $Output, '-target', $target, '-androidapi', $AndroidApi,
  '-javapkg=ai.magnetgate.core', '-libname=mgcore', '-trimpath', '-buildvcs=false',
  '-ldflags', $ldflags, '-tags', $tags, './mgbox'
) $engine
if ($LASTEXITCODE -ne 0) { throw 'gomobile bind failed' }

$built = Get-Item -LiteralPath $Output
Write-Host ("[ok] {0} ({1:N0} bytes)" -f $built.Name, $built.Length)
