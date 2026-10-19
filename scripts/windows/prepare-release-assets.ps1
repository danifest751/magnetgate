# Recover pinned runtime assets from the last verified public Windows release.
# The desktop app and peer host are rebuilt from this checkout, never copied.
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$zip = Join-Path $env:RUNNER_TEMP 'magnetgate-runtime-0.3.10.zip'
Invoke-WebRequest 'https://magnetvpn.world/downloads/magnetgate-0.3.10-b25afa1-win-x64.zip' -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne 'b6fd9e7214ccaaee720de837e753e4524c23f8a00e8be99e38be31b8d7a3bbe6') { throw 'Runtime archive checksum mismatch' }
$unpacked = Join-Path $env:RUNNER_TEMP 'magnetgate-runtime'
Expand-Archive $zip $unpacked -Force
foreach ($name in @('sing-box.exe', 'wintun.dll', 'refilter-domains.srs', 'refilter-ip.srs', 'requant-wallet.exe')) {
  $found = @(Get-ChildItem $unpacked -Recurse -File -Filter $name)
  if ($found.Count -ne 1) { throw "Expected exactly one $name" }
  $folder = if ($name -eq 'requant-wallet.exe') { 'requant' } else { 'sing-box' }
  $dest = Join-Path $root "tools/$folder"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item $found[0].FullName (Join-Path $dest $name)
}
# beforePack verifies every file against scripts/pins.json, including the wallet.
