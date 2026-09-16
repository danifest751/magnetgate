# Shared helpers for the Android AAR builds. Dot-source this file; it defines functions only.

# Every gomobile binding brings the same go.Seq support classes with it, so two AARs in one app collide
# ("Duplicate class go.Seq"). Both of our AARs are therefore built with the same toolchain - sing-box's
# fork, which is what its own libbox build uses - and the core's copy is stripped afterwards so the app
# ends up with exactly one set of them.
function Get-GomobileSagernet($Pins, [string]$Sdk, [string]$GoExe) {
  $pin = $Pins.singBoxSource
  if (-not $pin) { throw 'scripts/pins.json has no singBoxSource entry' }
  $bin = Join-Path (Split-Path -Parent $Sdk) 'gomobile-sagernet'
  $gomobile = Join-Path $bin 'gomobile.exe'
  if (-not (Test-Path -LiteralPath $gomobile)) { $gomobile = Join-Path $bin 'gomobile' }
  if (Test-Path -LiteralPath $gomobile) { return $gomobile }

  Write-Host "[tool] installing $($pin.gomobileFork)/cmd/gomobile@$($pin.gomobileVersion)"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $env:GOBIN = $bin
  Invoke-Native $GoExe @('install', "$($pin.gomobileFork)/cmd/gomobile@$($pin.gomobileVersion)") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "installing gomobile from $($pin.gomobileFork) failed" }
  Invoke-Native $GoExe @('install', "$($pin.gomobileFork)/cmd/gobind@$($pin.gomobileVersion)") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "installing gobind from $($pin.gomobileFork) failed" }
  if (-not (Test-Path -LiteralPath $gomobile)) { throw "gomobile was installed but is not at $gomobile" }
  return $gomobile
}

# Invoke-Native keeps a native command's stderr from becoming a terminating error under PowerShell 5.1.
function Invoke-Native([string]$file, [string[]]$arguments, [string]$workdir) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    if ($workdir) { Push-Location $workdir }
    & $file @arguments
  } finally {
    if ($workdir) { Pop-Location }
    $ErrorActionPreference = $previous
  }
}
