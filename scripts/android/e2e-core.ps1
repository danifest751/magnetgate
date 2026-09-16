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

function Start-Node([string]$name, [string[]]$arguments, [hashtable]$environment, [string]$logName) {
  foreach ($key in $environment.Keys) { Set-Item -Path "env:$key" -Value $environment[$key] }
  $out = Join-Path $tmp "$logName.out.log"
  $err = Join-Path $tmp "$logName.err.log"
  $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $root `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $script:processes += $process
  return $process
}

function Log-Text([string]$name) {
  $path = Join-Path $tmp "$name.out.log"
  if (Test-Path -LiteralPath $path) { return (Get-Content -LiteralPath $path -Raw) }
  return ''
}

function Wait-For([string]$label, [scriptblock]$probe, [int]$Seconds = 60) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    try { $value = & $probe; if ($value) { return $value } } catch {}
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
  Start-Node 'target' @($targetJs) @{} 'target' | Out-Null

  # 2. three local DHT nodes: the first is the bootstrap for the other two
  for ($i = 0; $i -lt $DhtPorts.Count; $i++) {
    $args = @((Join-Path $root 'src\dht-node.mjs'), [string]$DhtPorts[$i])
    if ($i -gt 0) { $args += "127.0.0.1:$($DhtPorts[0])" }
    Start-Node "dht-$i" $args @{} "dht-$i" | Out-Null
  }
  Start-Sleep -Seconds 2

  # 3. two exits, one PSK, different slots; each watches the other's slot
  foreach ($node in $Nodes) {
    Start-Node $node.name @((Join-Path $root 'src\exit.js')) @{
      MAGNETGATE_PSK           = $Psk
      MAGNETGATE_PORT          = [string]$node.port
      MAGNETGATE_PUBLIC_HOST   = '127.0.0.1'
      MAGNETGATE_NODE_SLOT     = [string]$node.slot
      MAGNETGATE_NODE_NAME     = $node.name
      MAGNETGATE_ALLOW_PRIVATE = '1'
      MAGNETGATE_NOSTR         = 'off'
      MAGNETGATE_TRANSPORT     = 'tcp'
      MAGNETGATE_PEER_SLOTS    = ($Nodes | ForEach-Object { $_.slot }) -join ','
      MAGNETGATE_PUBLISH_MS    = '5000'
      MAGNETGATE_SEQ_FILE      = Join-Path $tmp "seq-$($node.slot)"
      MAGNETGATE_HEALTH_FILE   = Join-Path $tmp "health-$($node.slot).json"
      DHT_BOOTSTRAP            = $bootstrap
    } $node.name | Out-Null
  }

  # the exits only need their environment at spawn time: do not leak it into the harness below
  foreach ($key in @('MAGNETGATE_PSK', 'MAGNETGATE_PORT', 'MAGNETGATE_PUBLIC_HOST', 'MAGNETGATE_NODE_SLOT',
      'MAGNETGATE_NODE_NAME', 'MAGNETGATE_ALLOW_PRIVATE', 'MAGNETGATE_NOSTR', 'MAGNETGATE_TRANSPORT',
      'MAGNETGATE_PEER_SLOTS', 'MAGNETGATE_PUBLISH_MS', 'MAGNETGATE_SEQ_FILE', 'MAGNETGATE_HEALTH_FILE',
      'DHT_BOOTSTRAP')) {
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

  # 4. build the core and run it with the rendezvous: no exit address is given
  $binary = Join-Path $tmp 'agent-cli.exe'
  Push-Location $core
  try { & $goExe build -o $binary ./cmd/agent-cli } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'go build failed' }

  # The harness logs to stderr on purpose. PowerShell 5.1 turns a native command's stderr into error
  # records, so merge the two streams in cmd instead and read the file.
  $outFile = Join-Path $tmp 'agent-cli.log'
  $commandLine = '"{0}" -slots 0 -bootstrap {1} -discover 45s -check "http://127.0.0.1:{2}/" > "{3}" 2>&1' -f $binary, $bootstrap, $TargetPort, $outFile
  $oldPsk = $env:MG_PSK
  $env:MG_PSK = $Psk
  try {
    & cmd.exe /c $commandLine
    $code = $LASTEXITCODE
  } finally {
    $env:MG_PSK = $oldPsk
  }
  $text = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
  Say '--- core output ---'
  foreach ($line in ($text -split "`r?`n")) { if ($line.Trim()) { Say "  $line" } }

  Check ($text -match 'exit slot 0 at ') 'the core found and used a node address it was never told'
  Check ($text -match 'target-ok') 'a request through the core reached the local target over the found endpoint'
  Check ($text -match 'discovered slot 1 from peers') 'the second slot was learned from the first node, not from config'
  Check ($code -eq 0) "the harness exited cleanly (code $code)"
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
