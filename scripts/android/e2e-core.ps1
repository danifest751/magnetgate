#Requires -Version 5.1
<#
.SYNOPSIS
  Runs the M2 acceptance stand and drives the Go core against it.

.DESCRIPTION
  Starts the same hermetic stand as scripts/dev/multi-node-lab.mjs — three local DHT nodes, two exits
  publishing under one PSK (different slots), and a local HTTP target — and then runs
  app-android/core/cmd/agent-cli with the rendezvous enabled instead of a known exit. It checks what M2
  must deliver before Compose exists:

    * the core finds a node's offer on the DHT by itself (no address in its config);
    * the offer unseals and yields a usable native endpoint (a node address must never be hardcoded);
    * a request through the core's SOCKS listener reaches the local target via that endpoint;
    * the second slot is learned from the first node's `peers` list, not from configuration.

  Nothing leaves loopback: exits dial the local target, the DHT is three local nodes.

.EXAMPLE
  powershell -File scripts/android/e2e-core.ps1
  powershell -File scripts/android/e2e-core.ps1 -Go C:\Users\me\sdk\go\bin\go.exe -Keep
#>
[CmdletBinding()]
param(
  [string]$Go = '',
  [int]$TargetPort = 29620,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core = Join-Path $root 'app-android\core'
if (-not (Test-Path -LiteralPath $core)) { throw "core not found under $core" }
$goExe = if ($Go) { $Go } elseif ($env:MG_GO) { $env:MG_GO } else { 'go' }

# Not a secret: the same lab PSK scripts/dev/multi-node-lab.mjs uses, and it never leaves loopback.
$Psk = 'lab-psk-0123456789abcdef0123456789abcdef'
$DhtPorts = @(29501, 29502, 29503)
$NostrPort = 29603
$Nodes = @(
  @{ name = 'lab-a'; slot = 0; port = 29601 },
  @{ name = 'lab-b'; slot = 1; port = 29602 }
)
$bootstrap = ($DhtPorts | ForEach-Object { "127.0.0.1:$_" }) -join ','

$tmp = Join-Path $env:TEMP ("mg-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$processes = @()
$failures = @()

function Say([string]$message) { Write-Host "[e2e] $message" }

function Check([bool]$ok, [string]$message) {
  if ($ok) { Say "  PASS  $message" } else { Say "  FAIL  $message"; $script:failures += $message }
}

function Start-Node([string[]]$arguments, [hashtable]$environment, [string]$logName) {
  foreach ($key in $environment.Keys) { Set-Item -Path "env:$key" -Value $environment[$key] }
  $out = Join-Path $tmp "$logName.out.log"
  $err = Join-Path $tmp "$logName.err.log"
  $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $root `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $script:processes += $process
  return $process
}

# Invoke-Harness runs the core with the given channel flags and returns its output and exit code.
#
# The harness logs to stderr on purpose. PowerShell 5.1 turns a native command's stderr into error
# records, so merge the two streams in cmd instead and read the file.
function Invoke-Harness([string]$logName, [string[]]$channelFlags) {
  $outFile = Join-Path $tmp $logName
  $commandLine = '"{0}" {1} -discover 45s -check "http://127.0.0.1:{2}/" > "{3}" 2>&1' -f $binary, ($channelFlags -join ' '), $TargetPort, $outFile
  $oldPsk = $env:MG_PSK
  $env:MG_PSK = $Psk
  try {
    & cmd.exe /c $commandLine
    $code = $LASTEXITCODE
  } finally {
    $env:MG_PSK = $oldPsk
  }
  $text = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
  return @{ Code = $code; Text = $text }
}

function Log-Text([string]$name) {
  $path = Join-Path $tmp "$name.out.log"
  if (Test-Path -LiteralPath $path) { return (Get-Content -LiteralPath $path -Raw) }
  return ''
}

# Wait-For polls a probe until it returns anything that is not $null. Probes signal "not yet" with
# $null: a value is tested for null and not for truthiness, because 0 is a perfectly good answer here
# (slot 0) and PowerShell would treat it as false.
function Wait-For([string]$label, [scriptblock]$probe, [int]$Seconds = 60) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    try { $value = & $probe; if ($null -ne $value) { return $value } } catch {}
    Start-Sleep -Milliseconds 400
  }
  Say "timeout waiting for $label"
  return $null
}

try {
  Say "workdir $tmp"

  # 1. the local target the exits will dial
  $targetJs = Join-Path $tmp 'target.cjs'
  @"
require('http').createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/plain' })
  s.end('target-ok')
}).listen($TargetPort, '127.0.0.1', () => console.log('target on 127.0.0.1:$TargetPort'))
"@ | Set-Content -LiteralPath $targetJs -Encoding ASCII
  Start-Node @($targetJs) @{} 'target' | Out-Null

  # 1b. a local NIP-01 relay: the second rendezvous channel, hermetic like the rest of the stand
  Start-Node @((Join-Path $root 'scripts\dev\nostr-relay.mjs'), [string]$NostrPort) @{} 'relay' | Out-Null

  # 2. three local DHT nodes: the first is the bootstrap for the other two
  for ($i = 0; $i -lt $DhtPorts.Count; $i++) {
    $args = @((Join-Path $root 'src\dht-node.mjs'), [string]$DhtPorts[$i])
    if ($i -gt 0) { $args += "127.0.0.1:$($DhtPorts[0])" }
    Start-Node $args @{} "dht-$i" | Out-Null
  }
  Start-Sleep -Seconds 2

  # 3. two exits, one PSK, different slots; each watches the other's slot
  #
  # The slot-0 node also advertises a REALITY endpoint that nothing listens on. That is the only way to
  # exercise the per-plane policy end to end: a node that is alive on one plane and dead on another must
  # pause just the dead plane and keep carrying traffic over the live one, rather than being cooled off
  # as a whole. A unit test covers the policy; this covers the wiring around it.
  $deadRealityPort = 29699
  $dpFile = Join-Path $tmp 'dp-dead-reality.json'
  $dpDoc = @{ dp = @(@{
      t = 'reality'; host = '127.0.0.1'; port = $deadRealityPort; protocol = 4
      pbk = ('0' * 64); sni = 'example.com'; sid = '00'; flow = 'xtls-rprx-vision'; uuid = '00000000-0000-4000-8000-000000000000'
    }) }
  [System.IO.File]::WriteAllText($dpFile, ($dpDoc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

  # A rule-set manifest for the slot-0 node, so the offer path that carries it is exercised. The
  # checksum is of a file that does not exist anywhere: the point here is that the manifest survives
  # sealing, the Nostr channel and parsing, not that anything downloads it.
  $rsFile = Join-Path $tmp 'rulesets.json'
  $rsDoc = @{ v = 7; ts = 0; sets = @(@{
      tag = 'blocked-domains'
      url = 'https://example.invalid/refilter-domains.srs'
      sha256 = ('a' * 64)
      bytes = 12345
    }) }
  [System.IO.File]::WriteAllText($rsFile, ($rsDoc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

  $exitBySlot = @{}
  foreach ($node in $Nodes) {
    $exitBySlot[$node.slot] = Start-Node @((Join-Path $root 'src\exit.js')) @{
      MAGNETGATE_PSK           = $Psk
      MAGNETGATE_PORT          = [string]$node.port
      MAGNETGATE_PUBLIC_HOST   = '127.0.0.1'
      MAGNETGATE_NODE_SLOT     = [string]$node.slot
      MAGNETGATE_NODE_NAME     = $node.name
      MAGNETGATE_ALLOW_PRIVATE = '1'
      MAGNETGATE_NOSTR         = 'on'
      MAGNETGATE_NOSTR_RELAYS  = "ws://127.0.0.1:$NostrPort"
      MAGNETGATE_TRANSPORT     = 'tcp'
      MAGNETGATE_PEER_SLOTS    = ($Nodes | ForEach-Object { $_.slot }) -join ','
      MAGNETGATE_PUBLISH_MS    = '5000'
      MAGNETGATE_SEQ_FILE      = Join-Path $tmp "seq-$($node.slot)"
      MAGNETGATE_HEALTH_FILE   = Join-Path $tmp "health-$($node.slot).json"
      DHT_BOOTSTRAP            = $bootstrap
      MAGNETGATE_DP_FILE       = $(if ($node.slot -eq 0) { $dpFile } else { Join-Path $tmp 'dp-none.json' })
      MAGNETGATE_RULESETS_FILE = $(if ($node.slot -eq 0) { $rsFile } else { Join-Path $tmp 'rs-none.json' })
    } $node.name
  }

  # the exits only need their environment at spawn time: do not leak it into the harness below
  foreach ($key in @('MAGNETGATE_PSK', 'MAGNETGATE_PORT', 'MAGNETGATE_PUBLIC_HOST', 'MAGNETGATE_NODE_SLOT',
      'MAGNETGATE_NODE_NAME', 'MAGNETGATE_ALLOW_PRIVATE', 'MAGNETGATE_NOSTR', 'MAGNETGATE_NOSTR_RELAYS',
      'MAGNETGATE_TRANSPORT',
      'MAGNETGATE_PEER_SLOTS', 'MAGNETGATE_PUBLISH_MS', 'MAGNETGATE_SEQ_FILE', 'MAGNETGATE_HEALTH_FILE',
      'MAGNETGATE_DP_FILE', 'MAGNETGATE_RULESETS_FILE', 'DHT_BOOTSTRAP')) {
    Remove-Item -Path "env:$key" -ErrorAction SilentlyContinue
  }

  foreach ($node in $Nodes) {
    $healthPath = Join-Path $tmp "health-$($node.slot).json"
    $health = Wait-For "$($node.name) to publish" {
      if (-not (Test-Path -LiteralPath $healthPath)) { return $null }
      $value = Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json
      if ($value.ok -eq $true) { return $value }
      return $null
    }
    Check ($null -ne $health) "$($node.name) published to the local DHT (accepted by $($health.nodes) node(s))"
    $learned = Wait-For "$($node.name) to see its peer" {
      $value = Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json
      if ($value.peers -ge 1) { return $value }
      return $null
    } 30
    Check ($null -ne $learned) "$($node.name) sees the other slot and advertises it (peers=$($learned.peers))"
  }

  # the publisher half of the second channel: both slots on the local relay, one replaceable event each
  $stored = Wait-For 'both exits to publish to the relay' {
    $text = Log-Text 'relay'
    if (-not $text) { return $null }
    $count = ([regex]::Matches($text, 'stored kind 30078')).Count
    if ($count -ge 2) { return $count }
    return $null
  } 60
  Check ($null -ne $stored) "both slots published to the local relay ($stored event(s))"

  # 4. build the core and run it with the rendezvous: no exit address is given
  $binary = Join-Path $tmp 'agent-cli.exe'
  Push-Location $core
  try { & $goExe build -o $binary ./cmd/agent-cli } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'go build failed' }

  $slot0 = Invoke-Harness 'agent-cli-slot0.log' @('-slots','0','-bootstrap',$bootstrap)
  Say '--- core output (slot 0) ---'
  foreach ($line in ($slot0.Text -split "`r?`n")) { if ($line.Trim()) { Say "  $line" } }

  Check ($slot0.Text -match 'exit slot 0 at ') 'the core found and used a node address it was never told'
  Check ($slot0.Text -match 'target-ok') 'a request through the core reached the local target over the found endpoint'
  Check ($slot0.Text -match 'discovered slot 1 from peers') 'the second slot was learned from the first node, not from config'
  Check ($slot0.Code -eq 0) "the harness exited cleanly (code $($slot0.Code))"

  # The slot-0 node advertises reality (dead) and mgt (live). Preference order is reality, hy2, mgt, so
  # the core must try reality first, fail, pause THAT PAIR ONLY, and carry the request over the same
  # node's mgt - not cool the node off and go elsewhere.
  Check ($slot0.Text -match 'via mgt slot 0') `
    'a node whose reality is dead still carried the request over its own mgt'
  Check ($slot0.Text -notmatch 'via reality slot') `
    'no stream was carried over the reality endpoint nothing listens on'

  # 5. the same run against slot 1. Every exit seals its handshake with the key of its own slot, so this
  # fails if the core dials every node with slot 0's key. The command line also learns slot 0 from the
  # first offer, so the check has to see a stream actually carried by slot 1, not just discovered.
  $slot1 = Invoke-Harness 'agent-cli-slot1.log' @('-slots', '1', '-bootstrap', $bootstrap, '-hold', '6s', '-every', '1s')
  Say '--- core output (slot 1) ---'
  foreach ($line in ($slot1.Text -split "`r?`n")) { if ($line.Trim()) { Say "  $line" } }

  Check ($slot1.Text -match 'exit slot 1 at ') 'the core discovered the slot it was configured for'
  Check ($slot1.Text -match '\[dp\] stream to [^\r\n]* slot 1') 'a request was carried by the slot-1 node, so its key was derived per slot'
  Check ($slot1.Text -match 'target-ok') 'a request through the slot-1 node reached the local target'
  Check ($slot1.Code -eq 0) "the slot-1 run exited cleanly (code $($slot1.Code))"


  # 4b. the second channel on its own: no DHT bootstrap is given, so anything that is found came over
  # Nostr, and the absence of DHT lookups in the log says so
  $nostrRun = Invoke-Harness 'agent-cli-nostr.log' @('-slots', '0', '-relays', "ws://127.0.0.1:$NostrPort")
  Say '--- core output (Nostr only) ---'
  foreach ($line in ($nostrRun.Text -split "`r?`n")) { if ($line.Trim()) { Say "  $line" } }

  Check ($nostrRun.Text -match 'exit slot 0 at ') 'the core found a node over the second channel alone'
  Check ($nostrRun.Text -match 'target-ok') 'a request over the Nostr-discovered endpoint reached the target'
  Check ($nostrRun.Text -notmatch 'dht: lookup finished') 'no DHT was configured, so the offer came from the relay'
  Check ($nostrRun.Code -eq 0) "the Nostr-only run exited cleanly (code $($nostrRun.Code))"

  # The rule-set manifest rides the Nostr view only. Reaching the snapshot means it survived sealing,
  # the relay, unsealing and validation - the path a phone uses to learn which lists it should have.
  $snap = Join-Path $tmp 'snap-nostr.json'
  # -hold matters: the snapshot is written by a one-second ticker, and without it the run exits as soon
  # as the check returns - before anything has been written.
  $nostrSnapRun = Invoke-Harness 'agent-cli-nostr-snap.log' `
    @('-slots', '0', '-relays', "ws://127.0.0.1:$NostrPort", '-snapshot', $snap, '-hold', '5s')
  $manifest = $null
  if (Test-Path -LiteralPath $snap) {
    $doc = Get-Content -LiteralPath $snap -Raw | ConvertFrom-Json
    $manifest = ($doc.exits | Where-Object { $_.rs }) | Select-Object -First 1
  }
  Check ($null -ne $manifest) 'the rule-set manifest reached the client over Nostr'
  if ($manifest) {
    Check ($manifest.rs.v -eq 7) "the manifest kept its generation ($($manifest.rs.v))"
    Check ($manifest.rs.sets[0].sha256 -eq ('a' * 64)) 'the manifest kept the checksum the node published'
  }


  # 6. failover: keep a client running, kill the node that carried the first stream, and require the
  # core to notice the dead pair, pause it in diagnostics and keep serving through the other node
  $snapshot = Join-Path $tmp 'snapshot.json'
  $runOut = Join-Path $tmp 'failover.out.log'
  $runErr = Join-Path $tmp 'failover.err.log'
  $oldPsk = $env:MG_PSK
  $env:MG_PSK = $Psk
  try {
    $long = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru `
      -ArgumentList @('-slots', '0', '-bootstrap', $bootstrap, '-discover', '45s',
        '-check', "http://127.0.0.1:$TargetPort/", '-hold', '40s', '-every', '2s', '-snapshot', $snapshot) `
      -RedirectStandardOutput $runOut -RedirectStandardError $runErr
  } finally {
    $env:MG_PSK = $oldPsk
  }

  function Run-Log {
    $text = ''
    foreach ($path in @($runOut, $runErr)) {
      if (Test-Path -LiteralPath $path) { $text += (Get-Content -LiteralPath $path -Raw) }
    }
    return $text
  }

  try {
    $served = Wait-For 'the first stream' {
      $match = [regex]::Match((Run-Log), '\[dp\] stream to [^\r\n]* slot (\d)')
      if ($match.Success) { return [int]$match.Groups[1].Value }
      return $null
    } 60
    Check ($null -ne $served) "the core carried a stream through slot $served"

    if ($null -ne $served) {
      $other = @($Nodes | Where-Object { $_.slot -ne $served } | ForEach-Object { $_.slot })[0]
      Write-Host "[e2e]   killing the node on slot $served"
      Stop-Process -Id $exitBySlot[$served].Id -Force -ErrorAction SilentlyContinue

      $noticed = Wait-For "the core to notice slot $served died" {
        if ((Run-Log) -match "transport failed: mgt slot $served") { return $true }
        return $null
      } 60
      Check ($null -ne $noticed) "the dead node was detected as a plane failure, not as a node failure"

      $paused = Wait-For "slot $served to appear as paused in diagnostics" {
        if (-not (Test-Path -LiteralPath $snapshot)) { return $null }
        try { $parsed = Get-Content -LiteralPath $snapshot -Raw | ConvertFrom-Json } catch { return $null }
        $row = $parsed.exits | Where-Object { $_.slot -eq $served }
        if ($row -and @($row.cooling | Where-Object { $_.t -eq 'mgt' }).Count -ge 1) { return $true }
        return $null
      } 30
      Check ($null -ne $paused) "the paused plane is published for diagnostics (node $served, plane mgt)"

      $moved = Wait-For "streams to keep working through slot $other" {
        $text = Run-Log
        $index = $text.IndexOf("transport failed: mgt slot $served")
        if ($index -lt 0) { return $null }
        $after = $text.Substring($index)
        if ($after -match 'check http://[^\r\n]*-> 200' -and $after -match "slot $other") { return $true }
        return $null
      } 60
      Check ($null -ne $moved) "requests kept being served, through slot $other, without a restart"
    }
  } finally {
    if ($long -and -not $long.HasExited) { Stop-Process -Id $long.Id -Force -ErrorAction SilentlyContinue }
  }
} catch {
  Say "error: $($_.Exception.Message)"
  $failures += $_.Exception.Message
  foreach ($name in @('lab-a', 'lab-b', 'dht-0', 'target')) {
    $log = Log-Text $name
    if ($log) { Say "--- $name log (tail) ---"; foreach ($line in (($log -split "`r?`n") | Select-Object -Last 15)) { Say "  $line" } }
  }
} finally {
  foreach ($process in $processes) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  if ($Keep) {
    Say "kept $tmp"
  } else {
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($failures.Count) {
    Say "FAILED: $($failures.Count) check(s)"
    exit 1
  }
  Say 'ALL CHECKS PASSED'
  exit 0
}

