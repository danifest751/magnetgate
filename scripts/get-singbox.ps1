# Downloads sing-box for Windows (x86_64) into tools\sing-box, verified against a pinned SHA-256.
# The magnetgate client uses this binary as its Reality/hysteria2 data-plane engine.
#   powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1
param(
  [string]$Version = '1.14.0',
  # SHA-256 of sing-box-<version>-windows-amd64.zip (verified 2026-09-12). Pass -Sha256 for another version.
  [string]$Sha256 = '3ffb56267da14e287be48bd10cf7e6505260125bad940b75101fbb4d5d58e5d6'
)
$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\sing-box'
$exe = Join-Path $tools 'sing-box.exe'
if (Test-Path $exe) { Write-Host "sing-box already present: $exe"; exit 0 }

New-Item -ItemType Directory -Force -Path $tools | Out-Null
$zip = Join-Path $env:TEMP "sing-box-$Version.zip"
$asset = "https://github.com/SagerNet/sing-box/releases/download/v$Version/sing-box-$Version-windows-amd64.zip"
Write-Host "downloading $asset"
Invoke-WebRequest -Uri $asset -OutFile $zip
$got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($got -ne $Sha256.ToLower()) {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Write-Error "sing-box checksum mismatch for ${Version}: got $got, expected $Sha256. Aborting."
  exit 1
}
Write-Host "checksum ok ($got)"
$tmp = Join-Path $env:TEMP "sing-box-$Version-extract"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp -Force
Copy-Item (Join-Path $tmp "sing-box-$Version-windows-amd64\sing-box.exe") $exe -Force
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "installed: $exe"
