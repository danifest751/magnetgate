$ErrorActionPreference = 'Stop'
$setup = @(Get-ChildItem app/dist -Filter '*-setup-x64.exe')
if ($setup.Count -ne 1) { throw 'Missing NSIS setup' }
$dest = Join-Path $env:ProgramFiles 'magnetgate'
$data = Join-Path $env:APPDATA 'magnetgate'
New-Item -ItemType Directory -Force $data | Out-Null
$sentinel = Join-Path $data 'installer-qa.txt'
Set-Content $sentinel 'preserve-wallet-and-personal-settings'
function Install {
  $process = Start-Process $setup[0].FullName -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit $($process.ExitCode)" }
  foreach ($file in @('magnetgate.exe', 'Uninstall magnetgate.exe', 'resources/app.asar', 'resources/tools/sing-box/sing-box.exe', 'resources/tools/sing-box/wintun.dll', 'resources/tools/peer/peer-node.exe', 'resources/tools/requant/requant-wallet.exe')) {
    if (-not (Test-Path (Join-Path $dest $file))) { throw "Installed file missing: $file" }
  }
}
Install
Install # In-place reinstall must preserve user data.
if ((Get-Content $sentinel -Raw).Trim() -ne 'preserve-wallet-and-personal-settings') { throw 'Reinstall changed user data' }
$links = @((Join-Path $env:PUBLIC 'Desktop/MagnetGate.lnk'), (Join-Path $env:ProgramData 'Microsoft/Windows/Start Menu/Programs/MagnetGate.lnk'))
foreach ($link in $links) { if (-not (Test-Path $link)) { throw "Shortcut missing: $link" } }
$uninstall = Start-Process (Join-Path $dest 'Uninstall magnetgate.exe') -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw 'Uninstaller failed' }
for ($i=0; $i -lt 30 -and (Test-Path (Join-Path $dest 'magnetgate.exe')); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path (Join-Path $dest 'magnetgate.exe')) { throw 'Application was not uninstalled' }
if (-not (Test-Path $sentinel)) { throw 'Uninstall deleted user data' }
foreach ($link in $links) { if (Test-Path $link) { throw "Shortcut remained: $link" } }
Write-Host 'PASS: installation, reinstall, desktop/Start Menu shortcuts, uninstall, retained user data'
