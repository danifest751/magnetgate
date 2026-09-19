#Requires -Version 5.1
<#
.SYNOPSIS
  Drives traffic through a live tunnel while the phone's network is taken away and given back.

.DESCRIPTION
  The client's worst day so far was a mobile network that re-registered every twenty minutes: every
  handover aborted the live connections and the engine kept dialling an interface that was gone. That was
  fixed on 18.09 and checked by hand - two circles of "Wi-Fi off / Wi-Fi on", six addresses in thirteen
  phases, counted by a person with a phone. This script is that check, made repeatable.

  It asks three questions, and demands a number for each:

    1. how long the phone is without a working tunnel after a handover (first success after the toggle);
    2. whether requests keep succeeding once the new network has settled (a sweep of several sites);
    3. which node carried them - both exits, alternating, or one exit doing all the work while the other
       is quietly dead (the pool round-robins, so a phase served by one node only is a finding).

  Traffic goes through the engine's health-check listener, which is the whole chain: engine -> core ->
  the plane the pool picked -> the exit. Requests from `adb shell` cannot be used instead: the system
  does not put shell uids in the VpnService ranges, so they leave the phone outside the tunnel while
  `ip route get` cheerfully says `dev tun0` (goto 37).

  The tunnel must already be up. Wi-Fi is switched back on whatever happens, including on Ctrl+C.

.EXAMPLE
  powershell -File scripts/android/switch-check.ps1 -Serial 4c75140c -Rounds 2
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  # One round is: away from Wi-Fi, back to Wi-Fi. Two rounds is what the hand-run did.
  [int]$Rounds = 2,
  # How long a handover is given to produce one working request before it is called a failure. Measured
  # on 18.09: the engine sees the new interface within seconds, but hy2 can take ~40 s to come back
  # because the relays have to reconnect first.
  [int]$RecoverSeconds = 90,
  [int]$ProbeEverySeconds = 5,
  # Small pages on purpose: this sweep asks whether sites open, and a heavy one measures the link
  # instead. The first run of this script failed on www.cloudflare.com and the finding was mine, not the
  # client's: 1.3 MB downloaded in full, which is seconds on a mobile network and nothing to do with
  # switching. Throughput is measured separately, by -ThroughputUrl.
  [string[]]$Urls = @(
    'https://api.ipify.org',
    'https://example.com',
    'https://www.cloudflare.com/cdn-cgi/trace',
    'https://ru.wikipedia.org',
    'https://github.com',
    'https://www.google.com'
  ),
  # One heavy page per phase, timed and measured rather than judged: a tunnel that opens every site and
  # carries 30 KB/s is broken in a way a sweep of small pages cannot see.
  [string]$ThroughputUrl = 'https://www.cloudflare.com',
  [int]$ThroughputSeconds = 40,
  [string]$ReportDir = ''
)

$ErrorActionPreference = 'Stop'
$appId = 'ai.magnetgate.client'

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw "adb not found at $adb (set ANDROID_HOME)" }

function Invoke-Native([string]$file, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try { & $file @arguments } finally { $ErrorActionPreference = $previous }
}
function Adb([string[]]$arguments) { return ((Invoke-Native $adb (@('-s', $script:serial) + $arguments)) -join "`n") }
function Shell([string]$command) { return (Adb @('shell', $command)) }
function Say([string]$message) { Write-Host "[switch] $message" }

$devices = (Invoke-Native $adb @('devices')) -split "`n" | Where-Object { $_ -match '^\S+\s+device\s*$' }
if (-not $devices) { throw 'no device is attached' }
$script:serial = if ($Serial) { $Serial } else { ($devices[0] -split '\s+')[0] }

if ($ReportDir -eq '') {
  $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $ReportDir = Join-Path $root ("app-android\build\switch-check\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force $ReportDir | Out-Null

# The listener is rebuilt with a fresh port on every engine reload, so it is read now rather than
# remembered from a previous run.
$config = Shell "run-as $appId cat files/configuration.json"
if (-not $config) { throw "the app has no live configuration: is the tunnel up?" }
$socks = ($config | ConvertFrom-Json).inbounds | Where-Object { $_.tag -eq 'in-health-check' } | Select-Object -ExpandProperty listen_port
if (-not $socks) { throw 'no health-check listener in the live configuration' }
if ((Shell 'ip route get 1.1.1.1') -notmatch 'dev tun') { throw 'no tunnel on this phone - bring it up first' }
Say "tunnel is up, driving traffic through 127.0.0.1:$socks"

$script:results = @()
$script:throughput = @()
function Fetch([string]$url) {
  $out = Shell "curl -s -o /dev/null -m 15 -w '%{http_code} %{time_total}' --socks5-hostname 127.0.0.1:$socks $url"
  $parts = ($out -replace "`r", '').Trim() -split '\s+'
  $code = if ($parts.Count -ge 1) { $parts[0] } else { '000' }
  $took = if ($parts.Count -ge 2) { [double]$parts[1] } else { 0 }
  return [pscustomobject]@{ url = $url; code = $code; seconds = $took; ok = ($code -eq '200' -or $code -eq '301' -or $code -eq '302') }
}

# Which exit answered. api.ipify.org gives it back as text, which is the only way to name the node from
# outside: the engine knows, but reading its log for every request would measure the log instead.
function Egress() {
  return ((Shell "curl -s -m 15 --socks5-hostname 127.0.0.1:$socks https://api.ipify.org") -replace "`r", '').Trim()
}

function Throughput([string]$phase) {
  $out = Shell ("curl -s -o /dev/null -m $ThroughputSeconds -w '%{http_code} %{size_download} %{speed_download}' " +
    "--socks5-hostname 127.0.0.1:$socks $ThroughputUrl")
  $parts = ($out -replace "`r", '').Trim() -split '\s+'
  if ($parts.Count -lt 3) { return $null }
  $mbps = [math]::Round([double]$parts[2] / 1MB, 2)
  Say ("  {0}: {1:N2} MB/s over {2} KB" -f $phase, $mbps, [math]::Round([double]$parts[1] / 1KB))
  return [pscustomobject]@{ phase = $phase; code = $parts[0]; bytes = [long]$parts[1]; mbPerSecond = $mbps }
}

function Sweep([string]$phase) {
  $rows = @()
  foreach ($url in $Urls) {
    $row = Fetch $url
    $rows += [pscustomobject]@{ at = (Get-Date).ToString('HH:mm:ss'); phase = $phase; url = $row.url; code = $row.code; seconds = $row.seconds; ok = $row.ok }
  }
  $script:throughput += Throughput $phase
  $exit = Egress
  $okCount = @($rows | Where-Object { $_.ok }).Count
  Say ("  {0}: {1}/{2} succeeded, median {3:N2}s, exit {4}" -f $phase, $okCount, $rows.Count,
    (($rows | Sort-Object seconds | Select-Object -Skip ([int]($rows.Count / 2)) -First 1).seconds), $exit)
  $script:results += $rows
  return [pscustomobject]@{ phase = $phase; ok = $okCount; total = $rows.Count; exit = $exit }
}

# How long until the tunnel carries anything again. The probe is one request, repeated, because that is
# the question the owner asks: "do sites open yet".
function WaitForTraffic([string]$phase) {
  $started = Get-Date
  $deadline = $started.AddSeconds($RecoverSeconds)
  $attempts = 0
  while ((Get-Date) -lt $deadline) {
    $attempts++
    $row = Fetch 'https://api.ipify.org'
    if ($row.ok) {
      $took = ((Get-Date) - $started).TotalSeconds
      Say ("  {0}: first success after {1:N0}s ({2} attempts)" -f $phase, $took, $attempts)
      return [pscustomobject]@{ phase = $phase; recoveredAfter = [math]::Round($took, 1); attempts = $attempts; recovered = $true }
    }
    Start-Sleep -Seconds $ProbeEverySeconds
  }
  Say ("  {0}: NO success within {1}s ({2} attempts)" -f $phase, $RecoverSeconds, $attempts)
  return [pscustomobject]@{ phase = $phase; recoveredAfter = $null; attempts = $attempts; recovered = $false }
}

$phases = @()
$timeline = @()
try {
  $timeline += [pscustomobject]@{ at = (Get-Date).ToString('HH:mm:ss'); event = 'start' }
  $phases += Sweep 'baseline (Wi-Fi)'

  for ($round = 1; $round -le $Rounds; $round++) {
    Say "round ${round}: taking Wi-Fi away"
    Shell 'svc wifi disable' | Out-Null
    $timeline += [pscustomobject]@{ at = (Get-Date).ToString('HH:mm:ss'); event = "round $round wifi off" }
    $phases += WaitForTraffic "round $round on mobile"
    $phases += Sweep "round $round on mobile"

    Say "round ${round}: giving Wi-Fi back"
    Shell 'svc wifi enable' | Out-Null
    $timeline += [pscustomobject]@{ at = (Get-Date).ToString('HH:mm:ss'); event = "round $round wifi on" }
    $phases += WaitForTraffic "round $round back on Wi-Fi"
    $phases += Sweep "round $round back on Wi-Fi"
  }
} finally {
  # Wi-Fi goes back on whatever happened: this runs on the owner's own phone, and leaving it on mobile
  # data because a run threw is not an acceptable way to end.
  Say 'restoring Wi-Fi'
  Shell 'svc wifi enable' | Out-Null
}

$failed = @($script:results | Where-Object { -not $_.ok })
$report = [ordered]@{
  at       = (Get-Date).ToString('o')
  device   = $script:serial
  socks    = $socks
  rounds   = $Rounds
  phases   = $phases
  timeline = $timeline
  requests = $script:results
  throughput = $script:throughput
  failures = $failed.Count
}
$path = Join-Path $ReportDir 'switch-check.json'
[System.IO.File]::WriteAllText($path, ($report | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Say "report written to $path"
Say ("{0} requests, {1} failed" -f $script:results.Count, $failed.Count)
if ($failed.Count) { exit 1 }
exit 0
