# Sets up system-wide VPN mode on Windows using tun2proxy (https://github.com/blechschmidt/tun2proxy).
# All traffic is routed through the magnetgate SOCKS5 client (127.0.0.1:1080), which tunnels
# everything via the DHT rendezvous to the exit. Requires administrator rights (TUN adapter).
#
# Usage (from an elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1            # connect
#   powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off       # disconnect (adapter removed on exit)
param(
  [switch]$Off,
  [string]$Version = 'v0.6.5',
  # SHA-256 of tun2proxy-x86_64-pc-windows-msvc.zip for the pinned $Version (verified 2026-09-12).
  # For any other $Version you MUST pass the matching -Sha256, or the download is rejected.
  [string]$Sha256 = '88f358b30ccf69f8439918e1f805b3482f2b033ff073a82e819ec532aa05c0d1'
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
  # supply-chain guard: this binary runs with admin rights, so verify it before extracting
  $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($got -ne $Sha256.ToLower()) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Write-Error "tun2proxy checksum mismatch for ${Version}: got $got, expected $Sha256. Aborting (pass -Sha256 for a different version)."
    exit 1
  }
  Write-Host "checksum ok ($got)"
  Expand-Archive $zip -DestinationPath $tools -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

Write-Host 'starting tun2proxy (all traffic -> 127.0.0.1:1080 -> DHT tunnel -> exit)...'
Write-Host 'stop with: powershell -File scripts\vpn-windows.ps1 -Off   (or Ctrl+C here)'
& (Join-Path $tools 'tun2proxy-bin.exe') --setup --proxy socks5://127.0.0.1:1080
