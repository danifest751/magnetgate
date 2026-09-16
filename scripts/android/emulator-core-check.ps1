#Requires -Version 5.1
<#
.SYNOPSIS
  Builds core/cmd/agent-cli for Android, runs it on an emulator and prints the end-to-end result.

.DESCRIPTION
  This is the "does the core work on a phone" gate that needs no APK: the harness serves SOCKS5 on the
  device's loopback, opens a native session to a real exit and fetches URLs through it. A green run
  proves SOCKS5 + handshake + mux + exit all work on Android, before Compose and libbox exist.

  The PSK is pushed to the device only for the duration of the run and removed afterwards; it is never
  passed on a command line. The AVD's userdata survives the run, so the removal is verified and a
  leftover copy is reported loudly: wipe the image (-wipe-data) if that ever happens.

.EXAMPLE
  powershell -File scripts/android/emulator-core-check.ps1 -Exit 203.0.113.10:49001 -PskFile key\psk.txt
  powershell -File scripts/android/emulator-core-check.ps1 -Exit 203.0.113.10:49001 -PskFile key\psk.txt -NoLaunch
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Exit,
  [Parameter(Mandatory = $true)][string]$PskFile,
  [string]$Avd = 'mg-test',
  [ValidateSet('amd64', 'arm64')][string]$Abi = 'amd64',
  [string]$Serial = 'emulator-5554',
  [string]$Go = '',
  [string[]]$Check = @('http://checkip.amazonaws.com/', 'https://example.com'),
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core = Join-Path $root 'app-android\core'
if (-not (Test-Path -LiteralPath $core)) { throw "core not found under $core" }
if (-not (Test-Path -LiteralPath $PskFile)) { throw "PSK file not found: $PskFile" }

# adb and go both write progress and warnings to stderr, and PowerShell 5.1 turns a native command's
# stderr into error records: with ErrorActionPreference=Stop that aborts the script even when the tool
# succeeded. Silence those records here and check exit codes explicitly instead.
function Invoke-Native([string]$file, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try { & $file @arguments } finally { $ErrorActionPreference = $previous }
}

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$ndk = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else { Get-ChildItem -LiteralPath (Join-Path $sdk 'ndk') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName }
if (-not $ndk) { throw "no NDK under $sdk\ndk and ANDROID_NDK_HOME is not set" }
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }

$triple = if ($Abi -eq 'amd64') { 'x86_64-linux-android26' } else { 'aarch64-linux-android26' }
$cc = Join-Path $ndk "toolchains\llvm\prebuilt\windows-x86_64\bin\$triple-clang.cmd"
if (-not (Test-Path -LiteralPath $cc)) { throw "no NDK compiler at $cc" }

$launched = $false
$binary = Join-Path $env:TEMP "mg-agent-cli-$Abi"
# Everything from here on is inside one try/finally: a failure while starting the emulator or building
# must still stop what we started and take the device copy of the PSK away.
try {
  $device = (Invoke-Native $adb @('devices')) -split "`n" | Where-Object { $_ -match "^$Serial\s+device" }
  if (-not $device) {
    if ($NoLaunch) { throw "$Serial is not attached and -NoLaunch was given" }
    Write-Host "[emu] starting $Avd"
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
  $release = ((Invoke-Native $adb @('-s', $Serial, 'shell', 'getprop ro.build.version.release')) -join '').Trim()
  $deviceAbi = ((Invoke-Native $adb @('-s', $Serial, 'shell', 'getprop ro.product.cpu.abi')) -join '').Trim()
  Write-Host "[emu] $Serial booted: Android $release $deviceAbi"

  Write-Host "[build] android/$Abi -> $binary"
  $saved = @{ GOOS = $env:GOOS; GOARCH = $env:GOARCH; CGO_ENABLED = $env:CGO_ENABLED; CC = $env:CC }
  try {
    $env:GOOS = 'android'; $env:GOARCH = $Abi; $env:CGO_ENABLED = '1'; $env:CC = $cc
    Push-Location $core
    Invoke-Native $goExe @('build', '-o', $binary, './cmd/agent-cli')
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }
  } finally {
    Pop-Location
    $env:GOOS = $saved.GOOS; $env:GOARCH = $saved.GOARCH; $env:CGO_ENABLED = $saved.CGO_ENABLED; $env:CC = $saved.CC
  }

  $checkArgs = ($Check | ForEach-Object { "-check `"$_`"" }) -join ' '
  Invoke-Native $adb @('-s', $Serial, 'push', $binary, '/data/local/tmp/agent-cli') | Out-Null
  Invoke-Native $adb @('-s', $Serial, 'push', $PskFile, '/data/local/tmp/mg-psk.txt') | Out-Null
  Invoke-Native $adb @('-s', $Serial, 'shell', 'chmod 700 /data/local/tmp/agent-cli; chmod 600 /data/local/tmp/mg-psk.txt') | Out-Null
  $remote = "/data/local/tmp/agent-cli -exit `"$Exit`" -psk-file /data/local/tmp/mg-psk.txt $checkArgs"
  Write-Host "[run] $remote"
  Invoke-Native $adb @('-s', $Serial, 'shell', $remote)
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "the on-device check failed with exit code $code" }
  Write-Host "[ok] the core works on android/$Abi"
} finally {
  Invoke-Native $adb @('-s', $Serial, 'shell', 'rm -f /data/local/tmp/agent-cli /data/local/tmp/mg-psk.txt') | Out-Null
  # The AVD's userdata survives a run, so a silently failed removal would leave the (un-rotated) PSK on
  # the image. Check, and say so loudly rather than trusting one best-effort rm.
  $left = ((Invoke-Native $adb @('-s', $Serial, 'shell', 'ls /data/local/tmp/mg-psk.txt 2>/dev/null')) -join '').Trim()
  if ($left) {
    Write-Warning "the PSK is still on $Serial at /data/local/tmp/mg-psk.txt - wipe the AVD data (-wipe-data) before reusing this image"
  }
  Remove-Item -LiteralPath $binary -ErrorAction SilentlyContinue
  if ($launched) { Invoke-Native $adb @('-s', $Serial, 'emu', 'kill') | Out-Null }
}
