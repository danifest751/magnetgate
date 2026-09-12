# System-wide VPN on Windows using sing-box's own TUN inbound (replaces tun2proxy). All traffic is
# captured by a TUN adapter and routed through the magnetgate SOCKS5 client (127.0.0.1:1080), which
# tunnels it via Reality/hysteria2/native to the exit. sing-box adds what tun2proxy did not: a
# fail-closed kill-switch (route.final = proxy + strict_route), DNS-leak protection (all DNS hijacked
# to a DoH resolver reached through the tunnel), and IPv6-leak protection (v6 rejected, since the
# exit egresses IPv4). Rendezvous, rotation and reality>hy2>native fail-over stay in the magnetgate
# client - this only replaces the TUN capture layer.
#
# Requires administrator rights (TUN adapter) and wintun.dll next to sing-box.exe.
# Usage (from an elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-singbox-windows.ps1            # connect
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-singbox-windows.ps1 -Off       # disconnect
#
# NOTE: do NOT run this on top of an active WireGuard (or other) full tunnel - two full tunnels
# conflict. Turn the other VPN off first, and keep a way to restore it locally.
param(
  [switch]$Off,
  # IPs to keep OFF the tunnel. The magnetgate client's own uplink to the exit must bypass the TUN,
  # or it loops back into 127.0.0.1:1080. Auto-filled from the config bootstrap IP literals; add the
  # exit IP here if it is not present as an IP literal.
  [string[]]$Bypass = @(),
  [string]$ConfigPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'magnetgate.config.json'),
  [int]$SocksPort = 1080,
  [string]$DohServer = '1.1.1.1',
  # wintun.dll (required by sing-box TUN on Windows). If missing, it is auto-downloaded from
  # wintun.net and verified against the pinned zip hash below; the extracted amd64 dll is checked
  # too. Pass -WintunSha256 for a different $WintunVersion, or drop wintun.dll (amd64) in by hand.
  [string]$WintunVersion = '0.14.1',
  # SHA-256 of wintun-0.14.1.zip (verified 2026-09-12).
  [string]$WintunSha256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51',
  # SHA-256 of the extracted bin\amd64\wintun.dll for 0.14.1 (verified 2026-09-12).
  [string]$WintunDllSha256 = 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
  # where sing-box (vpn.log) and this launcher (vpn-launcher.log) write, so a field test is readable
  # afterwards. Defaults to the app's log folder (Electron userData for productName "magnetgate").
  [string]$LogDir = (Join-Path $env:APPDATA 'magnetgate\logs'),
  # Clash API for live stats (connections / traffic), loopback-only. 0 disables it.
  [int]$ClashPort = 0,
  [string]$ClashSecret = ''
)
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
try { Start-Transcript -Path (Join-Path $LogDir 'vpn-launcher.log') -Append | Out-Null } catch {}
$ErrorActionPreference = 'Stop'
$root  = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root 'tools\sing-box'
$exe   = Join-Path $tools 'sing-box.exe'
$cfgOut = Join-Path $tools 'vpn-config.json'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

if ($Off) {
  Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'vpn-config\.json' } |
    ForEach-Object { Write-Host "stopping sing-box TUN PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'magnetgate sing-box TUN stopped (the adapter is removed automatically).'
  exit 0
}

if (-not (Test-Admin)) { Write-Error 'Run from an elevated (Administrator) PowerShell - the TUN adapter needs admin rights.'; exit 1 }
if (-not (Test-Path $exe)) { Write-Error "sing-box not found at $exe - run scripts\get-singbox.ps1 first."; exit 1 }

# wintun.dll is required by sing-box for the TUN inbound on Windows
$wintun = Join-Path $tools 'wintun.dll'
if (-not (Test-Path $wintun)) {
  if (-not $WintunSha256) {
    Write-Error "wintun.dll is missing from $tools. Place wintun.dll (amd64) there manually, or re-run with -WintunSha256 <sha256 of wintun-$WintunVersion.zip> to auto-download from wintun.net."
    exit 1
  }
  $zip = Join-Path $env:TEMP "wintun-$WintunVersion.zip"
  $url = "https://www.wintun.net/builds/wintun-$WintunVersion.zip"
  Write-Host "downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($got -ne $WintunSha256.ToLower()) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Write-Error "wintun checksum mismatch for ${WintunVersion}: got $got, expected $WintunSha256. Aborting."
    exit 1
  }
  Write-Host "checksum ok ($got)"
  $tmp = Join-Path $env:TEMP "wintun-$WintunVersion-extract"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $tmp -Force
  $srcDll = Join-Path $tmp 'wintun\bin\amd64\wintun.dll'
  if ($WintunDllSha256) {
    $dllGot = (Get-FileHash -Algorithm SHA256 $srcDll).Hash.ToLower()
    if ($dllGot -ne $WintunDllSha256.ToLower()) {
      Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
      Write-Error "wintun.dll checksum mismatch: got $dllGot, expected $WintunDllSha256. Aborting."
      exit 1
    }
  }
  Copy-Item $srcDll $wintun -Force
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "installed: $wintun"
}

# safety: warn if another full tunnel (e.g. WireGuard) is currently up
$upVpn = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'WireGuard|WinTun|TAP|OpenVPN' -or $_.Name -match 'WireGuard|wg')
}
if ($upVpn) { Write-Warning ("Another tunnel adapter is UP: " + (($upVpn.Name) -join ', ') + ". Two full tunnels will conflict - turn it off before continuing.") }

# sanity: is the magnetgate client listening?
$socks = Test-NetConnection -ComputerName 127.0.0.1 -Port $SocksPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $socks) { Write-Error "magnetgate client is not listening on 127.0.0.1:$SocksPort - start it first."; exit 1 }

# bypass list: the client's own uplink to the exit must stay off the TUN
$bypassIps = [System.Collections.Generic.List[string]]::new()
foreach ($b in $Bypass) { if ($b) { [void]$bypassIps.Add($b) } }
if (Test-Path $ConfigPath) {
  try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    foreach ($entry in @($cfg.bootstrap)) {
      $h = ([string]$entry -split ':')[0]
      if ($h -match '^\d{1,3}(\.\d{1,3}){3}$') { [void]$bypassIps.Add($h) }
    }
  } catch { Write-Warning "could not parse $ConfigPath for bypass IPs: $($_.Exception.Message)" }
}
$bypassIps = @($bypassIps | Select-Object -Unique)
if ($bypassIps.Count -eq 0) {
  # abort instead of bringing up a TUN that is guaranteed to loop: with no exit IP bypassed, the
  # client's own uplink to the exit is captured by the TUN and fed back into the SOCKS proxy.
  Write-Error 'No exit/DHT IP to bypass. Pass -Bypass <exit-ip> (or put the exit IP as an IP literal in the config bootstrap). Refusing to start — without it the tunnel loops and nothing connects.'
  exit 1
}
Write-Host ("bypassing (kept off the tunnel): " + ($bypassIps -join ', '))

# build the sing-box config from a template (written to a file, so no arg-quoting issues). The
# bypass rule is injected only when there is at least one IP to bypass.
# sing-box logs to a file (forward slashes so no JSON escaping needed) so the field test is readable
$logOut = ($LogDir -replace '\\', '/') + '/vpn.log'
# optional Clash API block for live stats
$clashBlock = ''
if ($ClashPort -gt 0) {
  $clashBlock = "`n  `"experimental`": { `"clash_api`": { `"external_controller`": `"127.0.0.1:$ClashPort`", `"secret`": `"$ClashSecret`" } },"
}
$bypassRule = ''
if ($bypassIps.Count -gt 0) {
  $cidrJson = (($bypassIps | ForEach-Object { '"' + $_ + '/32"' }) -join ', ')
  $bypassRule = "`n      { `"ip_cidr`": [ $cidrJson ], `"action`": `"route`", `"outbound`": `"direct`" },"
}
$json = @"
{
  "log": { "level": "info", "timestamp": true, "output": "$logOut" },$clashBlock
  "dns": {
    "servers": [ { "tag": "proxy-dns", "type": "https", "server": "$DohServer", "detour": "proxy" } ],
    "strategy": "ipv4_only"
  },
  "inbounds": [
    {
      "type": "tun", "tag": "tun-in", "interface_name": "magnetgate",
      "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      "mtu": 1400, "auto_route": true, "strict_route": true, "stack": "system"
    }
  ],
  "outbounds": [
    { "type": "socks", "tag": "proxy", "server": "127.0.0.1", "server_port": $SocksPort, "version": "5" },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "rules": [
      { "action": "sniff" },
      { "protocol": "dns", "action": "hijack-dns" },$bypassRule
      { "ip_is_private": true, "action": "route", "outbound": "direct" },
      { "ip_version": 6, "action": "reject" }
    ],
    "final": "proxy",
    "auto_detect_interface": true,
    "default_domain_resolver": "proxy-dns"
  }
}
"@
# write UTF-8 WITHOUT BOM (sing-box rejects a BOM)
[System.IO.File]::WriteAllText($cfgOut, $json, (New-Object System.Text.UTF8Encoding($false)))

# validate the generated config before touching the network
& $exe check -c $cfgOut
if ($LASTEXITCODE -ne 0) { Write-Error "the generated config failed 'sing-box check' - aborting."; exit 1 }
Write-Host "config OK: $cfgOut"

Write-Host 'starting sing-box TUN: all traffic -> magnetgate SOCKS -> exit.'
Write-Host '  kill-switch: ON (fail-closed)   IPv6: blocked   DNS: via tunnel (DoH)'
Write-Host 'stop with: powershell -ExecutionPolicy Bypass -File scripts\vpn-singbox-windows.ps1 -Off   (or Ctrl+C here)'
& $exe run -c $cfgOut
