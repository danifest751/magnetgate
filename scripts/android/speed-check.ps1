#Requires -Version 5.1
<#
.SYNOPSIS
  Measures what each plane actually carries, and how fast it answers, on a live phone.

.DESCRIPTION
  The client tries a node's planes in a declared order (src/health.mjs, PLANE_ORDER). That order decides
  where all traffic goes, and until this script existed it had been set from a single 8 MB download
  noticed by accident while fixing something else - after which three files disagreed about it for two
  days. A routing policy deserves a number that can be taken again, by someone else, and compared.

  So: for every road the phone has - each of the engine's per-plane SOCKS listeners, and the core's own
  listener on top of them - this downloads the same payload the same number of times and reports the
  median of two different questions:

    what it carries    - MB/s, which is what costs a person time on a download.
    how fast it answers - time to first byte, which is what costs them time on a page.

  Both, because they can disagree, and the order would then have to be split in two. So far they have
  not: on 2026-09-20 hy2 won both on both nodes.

  The core is measured deliberately, and it is the most useful row here. It is the road all ordinary
  traffic takes, so the gap between it and the best plane says what the core's own hops cost - except
  when it says something else entirely. Measured before the order was set from evidence: 0.53 MB/s
  against 2.82, which read like the price of going engine -> core -> engine again. It was not. The core
  was picking the slower plane; with the order fixed the same road carried 2.59 MB/s and the gap fell to
  8%. Read a large gap here as "look at what it chose" before reading it as "the core is expensive".

  Nothing is guessed from a config file: the ports come from the configuration the engine actually
  applied, read off the device.

  ⚠️ It refuses to run on a mobile network unless told twice, and the reason is correctness rather than
  cost: an LTE link caps every road at the same ceiling, so the transports come out looking equal and
  the link decides the ranking. Measure on Wi-Fi - `adb shell svc wifi enable` is enough, the cable
  keeps adb alive while the phone changes networks.

.EXAMPLE
  powershell -File scripts/android/speed-check.ps1 -Serial <serial>

.EXAMPLE
  # a quick look with less traffic, and the ranking still holds at this size
  powershell -File scripts/android/speed-check.ps1 -Serial <serial> -Bytes 2000000 -Rounds 2
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  # 8 MB is what the original finding used, and it is long enough that the ramp-up is not the whole
  # measurement. Smaller is fine for a ranking; smaller than ~1 MB measures the handshake instead.
  [long]$Bytes = 8000000,
  [int]$Rounds = 3,
  # Where the bytes come from. Cloudflare's own endpoint exists for exactly this and needs no account;
  # what matters is that it is the same source for every road, so the roads can be compared.
  [string]$Url = 'https://speed.cloudflare.com/__down?bytes=',
  [int]$TimeoutSeconds = 120,
  # Measuring on LTE spends the owner's data and answers the wrong question - see above.
  [switch]$AllowMobile,
  [string]$ReportDir = ''
)

$ErrorActionPreference = 'Stop'
$appId = 'ai.magnetgate.client'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw "adb not found at $adb (set ANDROID_HOME)" }

# adb writes progress to stderr, which PowerShell 5.1 turns into terminating errors (goto 20)
function Invoke-Native([string]$file, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try { & $file @arguments } finally { $ErrorActionPreference = $previous }
}
function Adb([string[]]$arguments) {
  $prefix = if ($Serial) { @('-s', $Serial) } else { @() }
  Invoke-Native $adb ($prefix + $arguments)
}
function Shell([string]$command) { (Adb @('shell', $command)) -join "`n" }

$model = (Shell 'getprop ro.product.model').Trim()
Write-Host "[speed] $(if ($Serial) { $Serial } else { 'device' }): $model"

# ---- refuse to answer the wrong question -------------------------------------------------------
# Parsed here rather than by `grep` on the device, and that is not a style choice: the first version of
# this guard sent a quoted pattern through `adb shell`, PowerShell 5.1 ate the quotes (the release.ps1
# trap, again), grep read its own pattern as a filename, the guard silently decided the phone was on
# Wi-Fi and the script spent ~46 MB of the owner's mobile data before it was stopped. A guard that fails
# open is worse than no guard, because it is trusted. Nothing quoted now leaves this file.
#
# The source is the engine's own log, which is the best answer available and the cheapest: the app tells
# the engine every time Android moves the tunnel to another network (MgVpnService.watchNetwork), so the
# last such line is what the engine is sitting on right now, in its own words. `dumpsys connectivity`
# says the same thing and takes tens of seconds to come over the cable; this is two hundred lines.
function ActiveTransport() {
  $log = (Adb @('exec-out', 'run-as', $appId, 'tail', '-n', '4000', 'files/engine.log')) -join "`n"
  $seen = [regex]::Matches($log, 'updated default interface\s+(\S+),\s*index\s*\d+,\s*type\s*(\w+)')
  if ($seen.Count) { return @($seen[$seen.Count - 1].Groups[2].Value, $seen[$seen.Count - 1].Groups[1].Value) }
  # No handover in this log: fall back to the routing table, where a default route on wlan means Wi-Fi.
  $routes = (Adb @('shell', 'ip', 'route', 'show', 'table', 'all')) -join "`n"
  $carriers = [regex]::Matches($routes, '(?m)^default\s.*\bdev\s+(\S+)') |
    ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -notmatch '^(tun|dummy)' }
  if ($carriers -match '^wlan') { return @('wifi', ($carriers -join ',')) }
  if ($carriers -match '^rmnet') { return @('cellular', ($carriers -join ',')) }
  # Fail closed. An unknown network is not a Wi-Fi network, and this guard exists because the previous
  # one decided otherwise.
  throw 'could not tell which network the phone is on, so this refuses to spend data guessing'
}
$state = ActiveTransport
$onMobile = $state[0] -eq 'cellular'
Write-Host "[speed] the engine is on $($state[1]) ($($state[0]))"
if ($onMobile -and -not $AllowMobile) {
  throw @'
the phone is on a mobile network, and the answer would be wrong.
An LTE link caps every road at the same ceiling, so reality and hy2 come out looking equal and the
ranking this script exists to produce is decided by the link instead of by the transports. That is the
reason to refuse even where the data is free: a confident wrong number is worse than none, and this
project has spent whole nights on exactly that.
Turn Wi-Fi on (`adb shell svc wifi enable`) and run this again, or pass -AllowMobile if the mobile link
is what you actually meant to measure.
'@
}
if ($onMobile) { Write-Host '[speed] on a mobile network by request: this measures the link, not the transports' }

# ---- the roads, taken from the configuration the engine applied, not from a guess ---------------
$configJson = (Adb @('exec-out', 'run-as', $appId, 'cat', 'files/configuration.json')) -join "`n"
if (-not $configJson.Trim().StartsWith('{')) { throw 'the engine has applied no configuration: is the tunnel up?' }
$config = $configJson | ConvertFrom-Json

$roads = @()
foreach ($inbound in $config.inbounds) {
  # in-health-check is the app's own way in, not a plane: measuring it would measure the core twice
  if ($inbound.type -ne 'socks' -or $inbound.tag -eq 'in-health-check') { continue }
  $roads += [pscustomobject]@{ name = $inbound.tag; port = [int]$inbound.listen_port }
}
$core = $config.outbounds | Where-Object { $_.tag -eq 'core' } | Select-Object -First 1
if ($core) { $roads += [pscustomobject]@{ name = 'core'; port = [int]$core.server_port } }
if (-not $roads.Count) { throw 'no roads found in the applied configuration' }

Write-Host ("[speed] {0} road(s), {1} MB x {2} round(s) each: {3}" -f
  $roads.Count, [math]::Round($Bytes / 1MB, 1), $Rounds, (($roads | ForEach-Object { $_.name }) -join ', '))
Write-Host ("[speed] about {0} MB of traffic in total" -f [math]::Round($roads.Count * $Rounds * $Bytes / 1MB, 0))

# ---- the probe itself, pushed as a file ---------------------------------------------------------
# Not passed as a command string: PowerShell 5.1 eats quotes on their way to `adb shell`, which is how
# release.ps1 once left a node serving the previous package (goto: release.ps1 quoting).
$probe = @'
#!/system/bin/sh
# $1 port, $2 url, $3 timeout. Prints: http_code time_total time_starttransfer size_download
curl -s --socks5-hostname "127.0.0.1:$1" --max-time "$3" -o /dev/null \
  -w '%{http_code} %{time_total} %{time_starttransfer} %{size_download}' "$2"
'@
$probePath = Join-Path ([System.IO.Path]::GetTempPath()) 'mg-speed-probe.sh'
# LF endings and no BOM: /system/bin/sh will not run a script with CRLF
[System.IO.File]::WriteAllText($probePath, ($probe -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
Adb @('push', $probePath, '/data/local/tmp/mg-speed-probe.sh') | Out-Null
Shell 'chmod 755 /data/local/tmp/mg-speed-probe.sh' | Out-Null
Remove-Item -LiteralPath $probePath -Force

function Median([double[]]$values) {
  if (-not $values.Count) { return 0 }
  $sorted = $values | Sort-Object
  $middle = [int][math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2) { return $sorted[$middle] }
  return ($sorted[$middle - 1] + $sorted[$middle]) / 2
}

$target = "$Url$Bytes"
$results = @()
foreach ($road in $roads) {
  $rates = @(); $firstBytes = @(); $failures = 0
  for ($round = 1; $round -le $Rounds; $round++) {
    $raw = (Shell "/data/local/tmp/mg-speed-probe.sh $($road.port) '$target' $TimeoutSeconds").Trim()
    $parts = $raw -split '\s+'
    # A road that answered 200 and carried nothing is a failure, not a fast one: absence of an error is
    # not a measurement (goto 37-38).
    if ($parts.Count -lt 4 -or $parts[0] -ne '200' -or [long]$parts[3] -lt $Bytes) {
      $failures++
      Write-Host ("[speed]   {0,-14} round {1}: FAILED ({2})" -f $road.name, $round, $raw)
      continue
    }
    $seconds = [double]$parts[1]
    $rate = if ($seconds -gt 0) { [long]$parts[3] / $seconds / 1MB } else { 0 }
    $rates += $rate
    $firstBytes += [double]$parts[2] * 1000
    Write-Host ("[speed]   {0,-14} round {1}: {2:N2} MB/s, first byte {3:N0} ms" -f $road.name, $round, $rate, ([double]$parts[2] * 1000))
  }
  $results += [pscustomobject]@{
    road = $road.name; port = $road.port; rounds = $Rounds; failures = $failures
    medianMBs = [math]::Round((Median $rates), 2)
    medianFirstByteMs = [math]::Round((Median $firstBytes), 0)
  }
}

Shell 'rm -f /data/local/tmp/mg-speed-probe.sh' | Out-Null

Write-Host ''
Write-Host '[speed] median of each road:'
Write-Host ('  {0,-14} {1,10} {2,14} {3,9}' -f 'road', 'MB/s', 'first byte', 'failed')
foreach ($r in ($results | Sort-Object -Property medianMBs -Descending)) {
  Write-Host ('  {0,-14} {1,10:N2} {2,11:N0} ms {3,9}' -f $r.road, $r.medianMBs, $r.medianFirstByteMs, "$($r.failures)/$($r.rounds)")
}

# The two orders this is evidence for, named so the output can be compared with src/health.mjs without
# anyone having to work out which column decides which.
$planes = $results | Where-Object { $_.road -ne 'core' -and $_.failures -lt $_.rounds }
$bulkOrder = ($planes | Sort-Object -Property medianMBs -Descending | ForEach-Object { ($_.road -split '-')[-1] }) | Select-Object -Unique
$fastOrder = ($planes | Sort-Object -Property medianFirstByteMs | ForEach-Object { ($_.road -split '-')[-1] }) | Select-Object -Unique
Write-Host ''
# Two rankings, printed apart on purpose. src/health.mjs declares one order because on every network
# measured so far these two agree; the day they disagree, this output is where it will show, and the
# split that was removed on 20.09 comes back with numbers behind it.
Write-Host ("[speed] ranked by what each carries:     {0}" -f ($bulkOrder -join ' > '))
Write-Host ("[speed] ranked by how fast each answers: {0}" -f ($fastOrder -join ' > '))
if (($bulkOrder -join ',') -ne ($fastOrder -join ',')) {
  Write-Host '[speed] the two rankings disagree: one order can no longer serve both, see PLANE_ORDER'
}
$coreRow = $results | Where-Object { $_.road -eq 'core' } | Select-Object -First 1
$best = $planes | Sort-Object -Property medianMBs -Descending | Select-Object -First 1
if ($coreRow -and $best -and $best.medianMBs -gt 0) {
  # This number is the whole reason the core is measured alongside the planes. On 20.09 it read 81%,
  # which looked like the price of the core's own hops - engine, core, engine again - and was not: the
  # core was simply picking the slower plane. With the order set from measurement it read 8%. A large
  # figure here means "look at what it chose" before it means "the core is expensive".
  Write-Host ("[speed] the core costs {0:N0}% of the best plane's throughput ({1:N2} vs {2:N2} MB/s)" -f
    ((1 - $coreRow.medianMBs / $best.medianMBs) * 100), $coreRow.medianMBs, $best.medianMBs)
}

if (-not $ReportDir) { $ReportDir = Join-Path $root ('app-android\build\speed-check\' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$report = [pscustomobject]@{
  at = (Get-Date).ToString('o'); device = @{ serial = $Serial; model = $model; mobile = $onMobile }
  bytes = $Bytes; rounds = $Rounds; url = $target
  roads = $results; bulkOrder = @($bulkOrder); interactiveOrder = @($fastOrder)
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ReportDir 'speed-check.json') -Encoding UTF8
Write-Host ''
Write-Host "[speed] report written to $ReportDir"
if (($results | Where-Object { $_.failures -eq $_.rounds }).Count) {
  Write-Host '[speed] some roads carried nothing at all - that is a finding, not a slow road'
}
