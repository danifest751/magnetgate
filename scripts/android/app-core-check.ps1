#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the Android app, runs it on an emulator and proves the core works inside it.

.DESCRIPTION
  The app embeds the Go core (see scripts/android/build-aar.ps1) and talks to it over JSON. This
  script builds both, installs the APK, hands the app its PSK through its private files directory, and
  launches it with an `autotest` extra: the app starts the core, waits for a discovered node, fetches
  https://api.ipify.org through the core's SOCKS listener and writes the result to files/autotest.txt.

  That exercises the part of the phone client that does not need a VPN yet: core inside the app process,
  discovery, and the app's own traffic through the exit. The PSK never appears on a command line and is
  removed from the device afterwards.

.EXAMPLE
  powershell -File scripts/android/app-core-check.ps1 -PskFile key\psk.txt -Bootstrap 203.0.113.10:20001
  powershell -File scripts/android/app-core-check.ps1 -PskFile key\psk.txt -Bootstrap 203.0.113.10:20001 -SkipAar
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PskFile,
  [Parameter(Mandatory = $true)][string]$Bootstrap,
  [string]$Relays = '',
  [string]$Avd = 'mg-test',
  [string]$Serial = 'emulator-5554',
  [string]$Go = '',
  [string]$Url = 'https://api.ipify.org',
  [int]$TimeoutSeconds = 150,
  [switch]$SkipAar,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $root 'app-android'
$appId = 'ai.magnetgate.client'
if (-not (Test-Path -LiteralPath $project)) { throw "app project not found under $project" }
if (-not (Test-Path -LiteralPath $PskFile)) { throw "PSK file not found: $PskFile" }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path (Split-Path -Parent $sdk) 'jdk17' }
if (-not (Test-Path -LiteralPath (Join-Path $jdk 'bin\java.exe'))) { throw "no JDK found (JAVA_HOME=$jdk); the app needs JDK 17" }

# adb and gradle write progress to stderr, which PowerShell 5.1 turns into error records
function Invoke-Native([string]$file, [string[]]$arguments, [string]$workdir) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    if ($workdir) { Push-Location $workdir }
    & $file @arguments
  } finally {
    if ($workdir) { Pop-Location }
    $ErrorActionPreference = $previous
  }
}

function Say([string]$message) { Write-Host "[app] $message" }

$failures = @()
function Check([bool]$ok, [string]$message) {
  if ($ok) { Say "  PASS  $message" } else { Say "  FAIL  $message"; $script:failures += $message }
}

if (-not $SkipAar) {
  Say 'building the core AAR'
  & (Join-Path $PSScriptRoot 'build-aar.ps1') -Go $Go
  if ($LASTEXITCODE -ne 0) { throw 'the core AAR failed to build' }
}

$launched = $false
$device = (Invoke-Native $adb @('devices')) -split "`n" | Where-Object { $_ -match "^$Serial\s+device" }
if (-not $device) {
  if ($NoLaunch) { throw "$Serial is not attached and -NoLaunch was given" }
  Say "starting $Avd"
  Start-Process -FilePath $emulator -ArgumentList @('-avd', $Avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect') | Out-Null
  $launched = $true
}
Invoke-Native $adb @('-s', $Serial, 'wait-for-device') | Out-Null
$deadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep -Seconds 4
  $boot = ((Invoke-Native $adb @('-s', $Serial, 'shell', 'getprop sys.boot_completed')) -join '').Trim()
} while ($boot -ne '1' -and (Get-Date) -lt $deadline)
if ($boot -ne '1') { throw "$Serial did not finish booting" }

try {
  Say 'building the app'
  $gradleArgs = @('--no-daemon', 'assembleDebug')
  $env:JAVA_HOME = $jdk
  Invoke-Native (Join-Path $project 'gradlew.bat') $gradleArgs $project | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gradle assembleDebug failed' }

  # The build is split per ABI (see app/build.gradle.kts), so install the package that matches this
  # device instead of a fat one: ~82 MB of native code per ABI is not worth pushing twice.
  $abi = ((Invoke-Native $adb @('-s', $Serial, 'shell', 'getprop', 'ro.product.cpu.abi')) -join '').Trim()
  if (-not $abi) { throw "could not read the ABI of $Serial" }
  $apkDir = Join-Path $project 'app\build\outputs\apk\debug'
  $apk = Join-Path $apkDir "app-$abi-debug.apk"
  if (-not (Test-Path -LiteralPath $apk)) {
    # a single-ABI or universal build still has to work
    $fallback = Join-Path $apkDir 'app-debug.apk'
    if (Test-Path -LiteralPath $fallback) { $apk = $fallback }
    else { throw "no APK for ABI '$abi' in $apkDir" }
  }
  Say "installing $(Split-Path -Leaf $apk) ($([math]::Round((Get-Item $apk).Length / 1MB)) MB, abi $abi)"
  Invoke-Native $adb @('-s', $Serial, 'install', '-r', $apk) | Out-Null

  # the PSK goes into the app's private directory, never on a command line
  Invoke-Native $adb @('-s', $Serial, 'push', $PskFile, '/data/local/tmp/mg-psk.txt') | Out-Null
  Invoke-Native $adb @('-s', $Serial, 'shell',
    "chmod 644 /data/local/tmp/mg-psk.txt; run-as $appId mkdir -p files; run-as $appId sh -c 'cat /data/local/tmp/mg-psk.txt > files/psk.txt'; rm -f /data/local/tmp/mg-psk.txt") | Out-Null

  Invoke-Native $adb @('-s', $Serial, 'shell', 'am', 'force-stop', $appId) | Out-Null
  Invoke-Native $adb @('-s', $Serial, 'shell', "run-as $appId rm -f files/autotest.txt") | Out-Null
  Invoke-Native $adb @('-s', $Serial, 'logcat', '-c') | Out-Null

  $extras = @('-e', 'autotest', 'true', '-e', 'bootstrap', $Bootstrap)
  if ($Relays) { $extras += @('-e', 'relays', $Relays) }
  Say "launching the app (bootstrap $Bootstrap)"
  Invoke-Native $adb (@('-s', $Serial, 'shell', 'am', 'start', '-n', "$appId/.MainActivity") + $extras) | Out-Null

  $until = (Get-Date).AddSeconds($TimeoutSeconds)
  $result = ''
  do {
    Start-Sleep -Seconds 5
    $result = ((Invoke-Native $adb @('-s', $Serial, 'shell', "run-as $appId cat files/autotest.txt 2>/dev/null")) -join '').Trim()
  } while (-not $result -and (Get-Date) -lt $until)

  Say "device result: $result"
  $logs = (Invoke-Native $adb @('-s', $Serial, 'logcat', '-d', '-s', 'magnetgate')) -join "`n"
  Check ($result -match 'port=[0-9]+') 'the core started inside the app and opened its SOCKS listener'
  Check ($result -match 'egress \d+\.\d+\.\d+\.\d+') 'the app reached the internet through the core and an exit'
  Check ($logs -notmatch 'core failed to start') 'the core reported no startup failure'
} finally {
  Invoke-Native $adb @('-s', $Serial, 'shell', "run-as $appId rm -f files/psk.txt files/autotest.txt") | Out-Null
  $left = ((Invoke-Native $adb @('-s', $Serial, 'shell', "run-as $appId ls files/psk.txt 2>/dev/null")) -join '').Trim()
  if ($left) { Write-Warning "the PSK is still on $Serial in $appId's files directory - uninstall or wipe the AVD" }
  if ($launched) { Invoke-Native $adb @('-s', $Serial, 'emu', 'kill') | Out-Null }
}

if ($failures.Count) {
  Say "FAILED: $($failures.Count) check(s)"
  exit 1
}
Say 'ALL CHECKS PASSED'
exit 0
