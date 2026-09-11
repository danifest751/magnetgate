# Sets up system-wide VPN mode on Windows using tun2proxy (https://github.com/blechschmidt/tun2proxy).
# All traffic is routed through the magnetgate SOCKS5 client (127.0.0.1:1080), which tunnels
# everything via the DHT rendezvous to the exit. Requires administrator rights (TUN adapter).
#
# Usage (from an elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1            # connect
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off       # disconnect (adapter removed on exit)
param(
  [switch]$Off,
  [string]$Version = 'v0.6.5'
)
$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\tun2proxy'

if ($Off) {
  Get-Process tun2proxy-bin -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host 'tun2proxy stopped (the TUN adapter is removed automatically).'
  exit 0
}

# quick sanity: is the magnetgate client up?
$socks = Test-NetConnection -ComputerName 127.0.0.1 -Port 1080 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $socks) { Write-Error 'magnetgate client is not listening on 127.0.0.1:1080 - start it first.'; exit 1 }

if (-not (Test-Path (Join-Path $tools 'tun2proxy-bin.exe'))) {
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $zip = Join-Path $env:TEMP 'tun2proxy.zip'
  $asset = "https://github.com/tun2proxy/tun2proxy/releases/download/$Version/tun2proxy-x86_64-pc-windows-msvc.zip"
  Write-Host "downloading $asset"
  Invoke-WebRequest -Uri $asset -OutFile $zip
  Expand-Archive $zip -DestinationPath $tools -Force
}

Write-Host 'starting tun2proxy (all traffic -> 127.0.0.1:1080 -> DHT tunnel -> exit)...'
Write-Host 'stop with: powershell -File scripts\vpn-windows.ps1 -Off   (or Ctrl+C here)'
& (Join-Path $tools 'tun2proxy-bin.exe') --setup --proxy socks5://127.0.0.1:1080
