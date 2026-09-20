#Requires -Version 5.1
<#
.SYNOPSIS
  Acceptance run for the phone client: brings the tunnel up on a device and demands proof it carries traffic.

.DESCRIPTION
  app-core-check.ps1 stops where the interesting part begins. It proves the core runs inside the app and
  reaches an exit through its own SOCKS listener, with no VPN in the picture. Everything that broke on
  17.09 broke past that line - a tunnel that was up and dialling a dead core port, a screen that said
  "Connected" while DNS was broken, a relay that was connected and mute - and every one of those was
  found by a person holding the phone.

  This script asks what that person asked, and fails unless it gets an affirmative answer:

    1. the core has one owner       one `core listening`, and the engine dialling that same port (goto 67)
    2. the exit answers             `check=ok` in health.txt, with how long it took (not "no error")
    3. the engine got every plane   as many planes as the core discovered, hy2 among them when a relay
                                    channel is on - hy2 rides Nostr only, so its absence is a mute relay
    4. the tunnel holds the routes  IPv4 and IPv6 on tun, MTU 1400, and no tun left after Disconnect
    5. nothing leaks when it dies   with lockdown on: no route and no bytes from another uid (goto 63)

  Absence of an error is never taken for success: every check names the string, route or number that has
  to be there. What the run saw is written to -ReportDir (device-check.json plus the raw evidence), so a
  failure can be read after the fact instead of reproduced with a phone in hand.

  The two destructive checks take the tunnel down on purpose, and on a device with the VPN lockdown on
  that means the phone has no network until the tunnel is back. The run brings it back and says whether
  it succeeded; -NoDisconnect and -NoFailClosed leave them out.

  The PSK is not pushed unless -PskFile is given: on a phone that has been used once it already lives in
  the Keystore, and a run that does not need the secret on disk should not put it there.

.EXAMPLE
  powershell -File scripts/android/device-check.ps1 -Bootstrap 203.0.113.10:20001 `
    -Relays 'wss://relay.example,wss://relay2.example'

.EXAMPLE
  # prove one channel on its own: `none` turns the other off for this run rather than falling back to
  # what the device has stored
  powershell -File scripts/android/device-check.ps1 -Channel dht -Bootstrap 203.0.113.10:20001
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  # Empty means "whatever the device has stored", which is the usual way to run this against a phone in
  # daily use. A value points the run at another node or relay set without touching the settings store.
  [string]$Bootstrap = '',
  [string]$Relays = '',
  [ValidateSet('stored', 'both', 'dht', 'nostr')][string]$Channel = 'stored',
  [string]$Mode = '',
  [string]$Url = 'https://api.ipify.org',
  [string]$PskFile = '',
  [string]$ReportDir = '',
  [int]$TimeoutSeconds = 210,
  # How long the system is given to bring the service back by itself after a crash. Measured at ~45 s on
  # 17.09 with MIUI autostart on; less than that and the check would report a failure of the phone's.
  [int]$RestartSeconds = 150,
  # How long the app is given to form an opinion about the exit. The service measures on a 60 s timer, so
  # anything under that would fail a phone that is simply between measurements.
  [int]$HealthSeconds = 120,
  [int]$ExpectPlanes = 0,
  [string]$Go = '',
  [switch]$SkipAar,
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$NoDisconnect,
  [switch]$NoFailClosed
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $root 'app-android'
$appId = 'ai.magnetgate.client'
$activity = "$appId/.MainActivity"
$probeV4 = '1.1.1.1'
$probeV6 = '2606:4700:4700::1111'
$expectedMtu = 1400

if (-not (Test-Path -LiteralPath $project)) { throw "app project not found under $project" }
if ($PskFile -and -not (Test-Path -LiteralPath $PskFile)) { throw "PSK file not found: $PskFile" }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw "adb not found at $adb (set ANDROID_HOME)" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path (Split-Path -Parent $sdk) 'jdk17' }

# adb and gradle write progress to stderr, which PowerShell 5.1 turns into terminating errors
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

function Say([string]$message) { Write-Host "[device] $message" }

$script:checks = @()
function Add-Check([string]$name, [bool]$ok, [string]$evidence) {
  $script:checks += [pscustomobject]@{ name = $name; ok = $ok; evidence = $evidence }
  if ($ok) { Say "  PASS  $name" } else { Say "  FAIL  $name" }
  if ($evidence) { Say "        $evidence" }
}

function Add-Skip([string]$name, [string]$why) {
  $script:checks += [pscustomobject]@{ name = $name; ok = $null; evidence = "skipped: $why" }
  Say "  SKIP  $name ($why)"
}

function Adb([string[]]$arguments) {
  return ((Invoke-Native $adb (@('-s', $script:serial) + $arguments)) -join "`n")
}

function Shell([string]$command) { return (Adb @('shell', $command)) }

# run-as is the only way to read the app's own files, and the only way to measure the core's network
# path rather than the tunnel's (goto 48)
function AsApp([string]$command) { return (Shell "run-as $appId $command") }

# PowerShell treats 0 as false, so a wait helper has to compare against $null and nothing else (goto 18)
function Wait-Until([int]$seconds, [int]$every, [scriptblock]$probe) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    $value = & $probe
    if ($null -ne $value -and "$value" -ne '') { return $value }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Seconds $every
  }
}

function Save-Text([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# A launch extra of `none` means "this channel is off for this run" (Settings.channel); leaving it out
# falls back to what the device has stored, which would quietly prove nothing about the channel asked for.
$bootstrapExtra = $Bootstrap
$relaysExtra = $Relays
switch ($Channel) {
  'dht' { $relaysExtra = 'none' }
  'nostr' { $bootstrapExtra = 'none' }
}
$nostrOn = $relaysExtra -ne 'none'

# ---------------------------------------------------------------- the device

$devices = (Invoke-Native $adb @('devices')) -split "`n" | Where-Object { $_ -match '^\S+\s+device\s*$' }
if (-not $devices) { throw 'no device is attached (adb devices is empty)' }
if ($Serial) {
  $script:serial = $Serial
  if (-not ($devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s" })) { throw "$Serial is not attached" }
} elseif (@($devices).Count -gt 1) {
  throw "more than one device is attached; name one with -Serial ($(($devices -replace '\s+device\s*$', '') -join ', '))"
} else {
  $script:serial = ($devices[0] -split '\s+')[0]
}

$model = (Shell 'getprop ro.product.model').Trim()
$release = (Shell 'getprop ro.build.version.release').Trim()
$abi = (Shell 'getprop ro.product.cpu.abi').Trim()
if (-not $abi) { throw "could not read the ABI of $($script:serial)" }
Say "$($script:serial): $model, Android $release, $abi"

if (-not $ReportDir) {
  $ReportDir = Join-Path $project ('build\device-check\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if (-not (Test-Path -LiteralPath $ReportDir)) { New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null }
$ReportDir = (Resolve-Path -LiteralPath $ReportDir).Path
Say "report goes to $ReportDir"

$lockdown = (Shell 'settings get secure always_on_vpn_lockdown').Trim()
$alwaysOn = (Shell 'settings get secure always_on_vpn_app').Trim()
$lockedDown = ($lockdown -eq '1' -and $alwaysOn -eq $appId)
if ($lockedDown) { Say 'the VPN lockdown is on: while the tunnel is down this phone has no network' }

# ---------------------------------------------------------------- build and install

if (-not $SkipBuild) {
  if (-not $SkipAar) {
    Say 'building the core AAR'
    & (Join-Path $PSScriptRoot 'build-aar.ps1') -Go $Go
    if ($LASTEXITCODE -ne 0) { throw 'the core AAR failed to build' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $jdk 'bin\java.exe'))) { throw "no JDK found (JAVA_HOME=$jdk); the app needs JDK 17" }
  Say 'building the app'
  $env:JAVA_HOME = $jdk
  Invoke-Native (Join-Path $project 'gradlew.bat') @('--no-daemon', 'assembleDebug') $project | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gradle assembleDebug failed' }
}

if (-not $SkipInstall) {
  $apkDir = Join-Path $project 'app\build\outputs\apk\debug'
  $apk = Join-Path $apkDir "app-$abi-debug.apk"
  if (-not (Test-Path -LiteralPath $apk)) {
    $fallback = Join-Path $apkDir 'app-debug.apk'
    if (Test-Path -LiteralPath $fallback) { $apk = $fallback } else { throw "no APK for ABI '$abi' in $apkDir" }
  }
  Say "installing $(Split-Path -Leaf $apk) ($([math]::Round((Get-Item $apk).Length / 1MB)) MB)"
  $install = Adb @('install', '-r', $apk)
  $present = (Shell "pm list packages $appId").Trim()
  if ($install -match 'Failure|INSTALL_FAILED' -or -not $present) {
    throw (
      "installing $apk on $($script:serial) failed ($install). adb writes the reason to stderr, which " +
      'PowerShell 5.1 does not capture; on a Xiaomi/MIUI device it is usually INSTALL_FAILED_USER_RESTRICTED: ' +
      'enable Developer options > Install via USB, and USB debugging (Security settings).'
    )
  }
}

if ($PskFile) {
  Say 'handing the app its PSK through its private files directory'
  Adb @('push', $PskFile, '/data/local/tmp/mg-psk.txt') | Out-Null
  Shell "chmod 644 /data/local/tmp/mg-psk.txt; run-as $appId mkdir -p files; run-as $appId sh -c 'cat /data/local/tmp/mg-psk.txt > files/psk.txt'; rm -f /data/local/tmp/mg-psk.txt" | Out-Null
}

# The VPN consent dialog cannot be answered by a script; a permission dialog left on top eats every
# `am start` that follows and the run would measure a tunnel that never started (goto 59).
$appops = (Shell "appops get $appId ACTIVATE_VPN").Trim()
$previousAppop = if ($appops -match 'ACTIVATE_VPN:\s*(\w+)') { $matches[1] } else { 'default' }
Shell "appops set $appId ACTIVATE_VPN allow" | Out-Null
Shell 'am force-stop com.google.android.permissioncontroller' | Out-Null

function Start-Tunnel([string]$bootstrap, [string]$relays, [switch]$Stored) {
  Shell 'am force-stop com.google.android.permissioncontroller' | Out-Null
  # The extras are read in onCreate, so an `am start` at an activity that already exists is delivered to
  # onNewIntent and starts nothing: the run would sit waiting for a tunnel nobody asked for. Starting
  # from a dead process also makes "one `core listening`" mean something. force-stop is wrong only when
  # what is being measured is the autostart itself (goto 62), and that check never comes through here.
  Shell "am force-stop $appId" | Out-Null
  $extras = @('-e', 'autotest', 'true', '-e', 'vpn', 'true')
  if (-not $Stored) {
    if ($bootstrap) { $extras += @('-e', 'bootstrap', $bootstrap) }
    if ($relays) { $extras += @('-e', 'relays', $relays) }
    if ($Mode) { $extras += @('-e', 'mode', $Mode) }
    if ($Url) { $extras += @('-e', 'checkurl', $Url) }
  }
  Adb (@('shell', 'am', 'start', '-n', $activity) + $extras) | Out-Null
}

function Tun-Of([string]$probe) {
  $flag = if ($probe -match ':') { '-6' } else { '' }
  # The interesting answer - `RTNETLINK answers: Permission denied`, which is what a closed network looks
  # like - goes to stderr, and PowerShell 5.1 does not put a native command's stderr in a variable
  # (goto 20). Merging the streams on the device rather than here is what makes it visible at all.
  $out = Shell "ip $flag route get $probe 2>&1"
  if ($out -match 'dev\s+(tun\d+)') { return $matches[1] }
  return ''
}

function Dump-Status() {
  Shell 'am force-stop com.google.android.permissioncontroller' | Out-Null
  Adb @('shell', 'am', 'start', '--activity-single-top', '-n', $activity, '-e', 'dump', 'true') | Out-Null
  Start-Sleep -Seconds 3
  return [pscustomobject]@{
    status = (AsApp 'cat files/status.txt 2>/dev/null')
    health = (AsApp 'cat files/health.txt 2>/dev/null').Trim()
  }
}

$restored = $false
try {
  # ---------------------------------------------------------------- the tunnel

  AsApp 'rm -f files/autotest.txt' | Out-Null
  Adb @('logcat', '-c') | Out-Null
  Say "bringing the tunnel up (channel $Channel, check $Url)"
  Start-Tunnel $bootstrapExtra $relaysExtra

  $result = Wait-Until $TimeoutSeconds 5 { (AsApp 'cat files/autotest.txt 2>/dev/null').Trim() }
  if (-not $result) { $result = '' }
  Say "device result: $result"

  # Two things about a phone that has just connected are true only after a while, and reading them once
  # fails a healthy device:
  #
  #  - the exit is measured on the service's own 60 s timer (later still when a rule-set manifest is
  #    being fetched on the same tick), so the first read says `check=none`, which means "not yet";
  #  - discovery keeps going after the tunnel is up. On the DHT-only run the tunnel came up carrying one
  #    node and the second arrived later; comparing a `tunnel up` line against a status read minutes
  #    afterwards compares two different moments and calls the difference a defect.
  #
  # So the status and the log are taken together, and the run waits for them to settle. It fails only if
  # they never do.
  $settled = 0
  $previous = -1
  while ($true) {
    $dump = Dump-Status
    # taken here, with the status, so both describe the same moment
    $logs = Adb @('logcat', '-d', '-s', 'magnetgate')
    $status = if ($dump.status) { $dump.status | ConvertFrom-Json } else { $null }

    $discovered = 0
    $hy2 = 0
    $exits = @()
    if ($status -and $status.snapshot -and $status.snapshot.exits) {
      foreach ($row in $status.snapshot.exits) {
        $types = @()
        foreach ($plane in $row.dp) { if ($plane.t) { $types += $plane.t } }
        $carried = @($types | Where-Object { $_ -eq 'reality' -or $_ -eq 'hy2' })
        $discovered += $carried.Count
        $hy2 += @($types | Where-Object { $_ -eq 'hy2' }).Count
        $exits += "$($row.name) slot $($row.slot) [$($types -join ' ')]"
      }
    }
    # what the engine carries now: the last reload wins, and the tunnel's own line when it never reloaded
    $tunnelUp = [regex]::Match($logs, 'tunnel up \(engine .*?core (\d+), engine planes (\d+)')
    $reloads = [regex]::Matches($logs, 'engine reloaded for \d+ node\(s\), (\d+) engine plane\(s\)')
    if ($reloads.Count -gt 0) {
      $planes = [int]$reloads[$reloads.Count - 1].Groups[1].Value
      $planesFrom = "the last of $($reloads.Count) engine reload(s)"
    } else {
      $planes = if ($tunnelUp.Success) { [int]$tunnelUp.Groups[2].Value } else { 0 }
      $planesFrom = 'the tunnel up line'
    }

    $healthKnown = ($dump.health -match 'check=(ok|failed)')
    $planesSettled = ($discovered -gt 0 -and $planes -ge $discovered)
    # Settling on the first agreeing snapshot would let the run pass while discovery is still going: one
    # node found, one plane carried, everything consistent and half the picture. The set has to stop
    # changing first, which also means the engine is given a node-watch tick to pick up a late arrival -
    # exactly the case this check exists for.
    $stable = ($discovered -gt 0 -and $discovered -eq $previous)
    # hy2 rides Nostr and nothing else, and a relay on a mobile network can take a minute and a half to
    # answer. Declaring it missing as soon as everything else agrees would fail a phone that is merely
    # waiting, so when a relay channel is configured this waits out the whole deadline for it.
    $relayCount = if ($status -and $status.relays) { @($status.relays).Count } else { 0 }
    $hy2Settled = (-not ($nostrOn -and $relayCount -gt 0)) -or $hy2 -gt 0
    if (($healthKnown -and $planesSettled -and $stable -and $hy2Settled) -or $settled -ge $HealthSeconds) { break }
    $previous = $discovered
    Start-Sleep -Seconds 10
    $settled += 10
  }
  Save-Text (Join-Path $ReportDir 'logcat-tunnel.txt') $logs
  Save-Text (Join-Path $ReportDir 'status.json') $dump.status
  Save-Text (Join-Path $ReportDir 'health.txt') $dump.health
  # The engine's own log is the only place a reset connection is explained; the core's log ends at
  # "stream opened". The tail is enough for a run, and the whole file stays on the device.
  Save-Text (Join-Path $ReportDir 'engine.log') (AsApp 'tail -n 3000 files/engine.log 2>/dev/null')

  # --- 1. the core has one owner ------------------------------------------------
  # Counted per process, not per line. The defect this guards (goto 67) is one *process* starting the
  # core twice and the engine then dialling a port nobody owns - two processes each starting their own
  # is not that, and happens for real: an install kills the previous app, and a run that installs
  # catches the dying process's last line in the same logcat window. It failed exactly that way on
  # 20.09 (pid 5831 on :44151 at 13:45:45.444, pid 11453 on :40943 0.7 s later, the second being the
  # build just installed) and the failure was the check's, not the phone's. The live process is the one
  # that wrote `app started`, and only its cores are counted.
  $listening = [regex]::Matches($logs, '(?m)^\S+\s+\S+\s+(\d+)\s+\d+\s+I magnetgate: core listening on 127\.0\.0\.1:(\d+)')
  $livePid = [regex]::Matches($logs, '(?m)^\S+\s+\S+\s+(\d+)\s+\d+\s+I magnetgate: app started') |
    Select-Object -Last 1 | ForEach-Object { $_.Groups[1].Value }
  $mine = @($listening | Where-Object { -not $livePid -or $_.Groups[1].Value -eq $livePid })
  $others = $listening.Count - $mine.Count
  $socksPort = if ($status) { [int]$status.socksPort } else { 0 }
  $corePort = if ($tunnelUp.Success) { [int]$tunnelUp.Groups[1].Value } else { 0 }
  Add-Check 'the tunnel came up' $tunnelUp.Success $(if ($tunnelUp.Success) { $tunnelUp.Value } else { 'no `tunnel up` line in the log' })
  Add-Check 'the core has exactly one owner' `
    ($mine.Count -eq 1 -and $corePort -ne 0 -and $corePort -eq $socksPort) `
    ("core listening x$($mine.Count) in pid $livePid" +
      $(if ($others) { " (and $others in an earlier process, which an install leaves behind)" } else { '' }) +
      ", engine dialling $corePort, status says $socksPort")

  # --- 2. the exit answers ------------------------------------------------------
  $health = [regex]::Match($dump.health, 'check=(\w+)(?:\s+took=(\d+)ms)?')
  $healthOk = ($health.Success -and $health.Groups[1].Value -eq 'ok')
  Add-Check 'the exit answered the health check' $healthOk `
    "$(if ($dump.health) { $dump.health } else { 'health.txt is empty: the app never measured' }) (settled after ${settled}s)"

  # --- 3. the engine got every plane the core found -----------------------------
  $wanted = if ($ExpectPlanes -gt 0) { $ExpectPlanes } else { $discovered }
  Add-Check 'the engine carries every plane the core discovered' `
    ($planes -gt 0 -and $wanted -gt 0 -and $planes -ge $wanted) `
    "engine planes $planes (from $planesFrom), discovered $discovered ($($exits -join ', '))"
  # The relay list can come from the settings store rather than this command line, so what decides is
  # what the core ended up with, not what was typed.
  if ($nostrOn -and $relayCount -gt 0) {
    # hy2 only ever arrives over Nostr - its certificate does not fit in a DHT record - so a run with a
    # relay channel and no hy2 means the relays are mute, whatever the relay list says
    Add-Check 'hy2 arrived, so a relay actually answered' ($hy2 -gt 0) "hy2 planes $hy2"
  } else {
    Add-Skip 'hy2 arrived, so a relay actually answered' "no relay channel in this run (relays configured: $relayCount)"
  }

  # --- the egress, measured through the tunnel ----------------------------------
  Add-Check 'the app reached the internet through an exit' ($result -match 'egress \d+\.\d+\.\d+\.\d+') $result

  # --- 4a. the tunnel holds the routes ------------------------------------------
  $tun4 = Tun-Of $probeV4
  $tun6 = Tun-Of $probeV6
  # /sys/class/net/<tun>/mtu is not readable from the shell uid on this phone, and `ip -o link show` is
  # refused as well (goto 31), so the MTU is taken from whichever of three sources answers: the app's own
  # uid, the shell, or the request the platform actually applied to the interface.
  $mtu = if ($tun4) { (AsApp "cat /sys/class/net/$tun4/mtu").Trim() } else { '' }
  $mtuFrom = 'the app uid'
  if ($mtu -notmatch '^\d+$') {
    $mtu = if ($tun4) { (Shell "cat /sys/class/net/$tun4/mtu").Trim() } else { '' }
    $mtuFrom = 'the shell uid'
  }
  if ($mtu -notmatch '^\d+$') {
    $applied = [regex]::Match($logs, '"MTU":\s*(\d+)')
    $mtu = if ($applied.Success) { $applied.Groups[1].Value } else { '' }
    $mtuFrom = 'the tun request the platform applied'
  }
  Add-Check 'IPv4 goes through the tunnel' ($tun4 -ne '') "ip route get $probeV4 -> $(if ($tun4) { "dev $tun4" } else { 'no tun' })"
  # IPv6 is not a detail: a resolver that answers AAAA while the tunnel carries no IPv6 is the regress of
  # 17.09, and it looks like "sites open strangely" rather than like a failure
  Add-Check 'IPv6 goes through the tunnel' ($tun6 -ne '') "ip -6 route get $probeV6 -> $(if ($tun6) { "dev $tun6" } else { 'no tun' })"
  Add-Check "the tun MTU is $expectedMtu" ($mtu -eq "$expectedMtu") "mtu $mtu, read from $mtuFrom"

  # --- 4b. Disconnect releases the tun ------------------------------------------
  if ($NoDisconnect) {
    Add-Skip 'Disconnect releases the tun' '-NoDisconnect'
  } else {
    Say 'taking the tunnel down to see what it releases'
    Adb @('shell', 'am', 'start', '--activity-single-top', '-n', $activity, '-e', 'stop', 'true') | Out-Null
    # the interface and its routes are torn down asynchronously; 20 s was the measured worst case
    $gone = Wait-Until 40 5 {
      $pidOf = ((Shell "pidof $appId").Trim() -split '\s+')[0]
      $fds = if ($pidOf) { AsApp "ls -l /proc/$pidOf/fd" } else { '' }
      $left = if ($fds -match '/dev/tun') { 'fd' } else { '' }
      $iface = if ((Tun-Of $probeV4) -ne '') { 'route' } else { '' }
      if (-not $left -and -not $iface) { 'released' } else { $null }
    }
    Add-Check 'Disconnect releases the tun' ($gone -eq 'released') `
      $(if ($gone -eq 'released') { 'no /dev/tun fd and no tun route within 40s' } else { 'a tun fd or a tun route outlived "tunnel down"' })

    Say 'bringing the tunnel back'
    Start-Tunnel $bootstrapExtra $relaysExtra
    $back = Wait-Until 120 5 { if ((Tun-Of $probeV4) -ne '') { 'up' } else { $null } }
    Add-Check 'the tunnel comes back after a Disconnect' ($back -eq 'up') "ip route get $probeV4 -> $(if ($back) { 'dev tun' } else { 'no tun' })"
  }

  # --- 5. the app dies: nothing leaks, and the tunnel comes back -----------------
  # Two different promises, and they used to share one gate. The leak check needs the lockdown to mean
  # anything - without it a phone with no tunnel is simply a phone on its own network. The recovery
  # check needs nothing: a tunnel that does not come back is broken either way, and gating it on the
  # lockdown meant that a phone with the lockdown switched off silently stopped testing the one thing
  # the watchdog exists for.
  if ($NoFailClosed) {
    Add-Skip 'nothing leaks while the app is dead' '-NoFailClosed'
    Add-Skip 'the tunnel comes back after the process dies' '-NoFailClosed'
  } else {
    $hasCurl = (Shell 'command -v curl').Trim()
    # How the app is made to die decides what is being measured. `am force-stop` suppresses the restart
    # outright (goto 62). `am crash` is reported as an application crash, MIUI files it and raises its
    # "stopped" dialog, and the service restart waits behind that dialog for a person (goto 75) - so it
    # measures the dialog. The kill hook ends the process the way an out-of-memory kill does, which is
    # the death this promise has to survive. A build without the hook falls back to `am crash`.
    Say 'killing the app to see whether the network closes and what comes back'
    $howItDied = 'the kill hook'
    Adb @('shell', 'am', 'start', '--activity-single-top', '-n', $activity, '-e', 'kill', 'true') | Out-Null
    # The hook finishes its activity before it dies, so that the system has no foreground screen to
    # restore and no reason to restart the app (goto 88) - that takes it a few seconds, and only after
    # them is a live process evidence that the hook is missing rather than evidence that it is working.
    Start-Sleep -Seconds 8
    if ((Shell "pidof $appId").Trim()) {
      $howItDied = 'am crash (the kill hook did nothing: not a debuggable build?)'
      Shell "am crash $appId" | Out-Null
    }
    Start-Sleep -Seconds 10
    if (-not $lockedDown) {
      Add-Skip 'nothing leaks while the app is dead' 'the VPN lockdown is not on for this app'
    } else {
      # measured from the shell uid on purpose: lockdown lets the VPN app itself out, so `run-as curl`
      # would report success and "prove" a protection that is not there (goto 63)
      $route = Shell "ip route get $probeV4 2>&1"
      $http = if ($hasCurl) { (Shell "curl -s -o /dev/null -m 10 -w '%{http_code}' $Url").Trim() } else { '' }
      $closed = ($route -match 'Permission denied' -or $route -match 'Network is unreachable')
      if ($hasCurl) { $closed = ($closed -and $http -eq '000') }
      Add-Check 'nothing leaks while the app is dead' $closed `
        "died by $howItDied; ip route get -> $(($route -split "`n")[0].Trim()); curl -> $(if ($hasCurl) { $http } else { 'no curl on the device' })"
    }

    Say "waiting up to ${RestartSeconds}s for the tunnel to come back without a person"
    $revived = Wait-Until $RestartSeconds 15 {
      if (((Shell "pidof $appId").Trim() -ne '') -and (Tun-Of $probeV4) -ne '') { 'up' } else { $null }
    }
    # The watchdog ticks once a minute, and a tunnel takes seconds to find a node, so a pass here is a
    # process that came back and an interface that carries a route - not merely a process.
    Add-Check 'the tunnel comes back after the process dies' ($revived -eq 'up') `
      $(if ($revived) { "died by $howItDied; the process came back and the tun with it" } else { "no tunnel after ${RestartSeconds}s: is the watchdog job scheduled (adb shell dumpsys jobscheduler | grep magnetgate)?" })
  }
} finally {
  # ---------------------------------------------------------------- put it back

  Say 'restoring the tunnel with the settings the device had before this run'
  if ($PskFile) { AsApp 'rm -f files/psk.txt' | Out-Null }
  # the evidence has been pulled into the report by now; what is left on the device is the node list and
  # the core's log ring, and neither belongs on a phone after the run that asked for it
  AsApp 'rm -f files/autotest.txt files/status.txt files/health.txt' | Out-Null
  # A tunnel that is up is not the same as the tunnel the owner had. A run that narrowed the channels
  # leaves it carrying the narrower set: with relays off there is no hy2 and no rule-set manifest, and
  # nothing says so - it just keeps running that way. So the restore restarts whenever this run overrode
  # anything, not only when the tunnel is down. Measured the hard way: a DHT-only run left the owner's
  # phone without hy2 until they noticed it missing on the screen.
  $overrode = ($bootstrapExtra -ne '' -or $relaysExtra -ne '' -or $Mode -ne '')
  if ($overrode -or (Tun-Of $probeV4) -eq '') { Start-Tunnel '' '' -Stored }
  $restored = (Wait-Until 150 5 { if ((Tun-Of $probeV4) -ne '') { 'up' } else { $null } }) -eq 'up'
  if ($previousAppop -ne 'allow') { Shell "appops set $appId ACTIVATE_VPN $previousAppop" | Out-Null }
  if (-not $restored) {
    Write-Warning (
      "the tunnel is NOT up on $($script:serial) and the lockdown may be leaving this phone without " +
      'network. Open MagnetGate on the device and press Connect.'
    )
  } else {
    Say 'the tunnel is up'
  }
}

# ---------------------------------------------------------------- the report

$failed = @($script:checks | Where-Object { $_.ok -eq $false })
$report = [ordered]@{
  at        = (Get-Date).ToString('o')
  device    = [ordered]@{ serial = $script:serial; model = $model; android = $release; abi = $abi; lockdown = $lockedDown }
  run       = [ordered]@{ channel = $Channel; bootstrap = $bootstrapExtra; relays = $relaysExtra; mode = $Mode; url = $Url }
  checks    = $script:checks
  restored  = $restored
  failures  = $failed.Count
}
Save-Text (Join-Path $ReportDir 'device-check.json') ($report | ConvertTo-Json -Depth 6)
Say "report written to $(Join-Path $ReportDir 'device-check.json')"

if ($failed.Count) {
  Say "FAILED: $($failed.Count) check(s): $(($failed | ForEach-Object { $_.name }) -join '; ')"
  exit 1
}
Say 'ALL CHECKS PASSED'
exit 0
