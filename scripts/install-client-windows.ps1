# Installs magnetgate as a Windows scheduled task that starts at logon.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 [-ConfigPath <path>] [-Uninstall]
# The config file (see magnetgate.config.example.json) must contain the PSK and exit list.
param(
  [string]$ConfigPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'magnetgate.config.json'),
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$task = 'magnetgate-client'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($Uninstall) {
  schtasks /Delete /TN $task /F 2>$null
  Write-Host "task '$task' removed"
  exit 0
}

if (-not (Test-Path $ConfigPath)) {
  Write-Error "config not found: $ConfigPath (copy magnetgate.config.example.json and fill in the PSK)"
  exit 1
}
$config = (Resolve-Path $ConfigPath).Path

# runner script with baked-in paths
$runTemplate = Join-Path $PSScriptRoot 'run-client.ps1'
$runner = Join-Path $env:LOCALAPPDATA 'magnetgate\run-client.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path $runner) | Out-Null
(Get-Content $runTemplate -Raw) -replace '<REPO>', $repo -replace '<CONFIG>', $config | Set-Content $runner -Encoding utf8

# npm install if needed
if (-not (Test-Path (Join-Path $repo 'node_modules'))) {
  Push-Location $repo; npm ci --omit=dev --loglevel=error; Pop-Location
}

schtasks /Create /TN $task /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" /SC ONLOGON /RL LIMITED /F
Write-Host "task '$task' created. start now: schtasks /Run /TN $task"
