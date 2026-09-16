# Downloads the sing-box data-plane engine and the routing rule-sets into tools\sing-box.
# Every artifact is verified against scripts\pins.json (single source of truth for versions + SHA-256),
# so a changed upstream file stops the fetch instead of silently retuning routes or swapping a binary.
#   powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1 -Force     # re-download and re-check
param(
  # Override the pinned sing-box version/checksum only together with a matching entry in pins.json.
  [string]$Version,
  [string]$Sha256,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\sing-box'
$exe = Join-Path $tools 'sing-box.exe'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

$pinsPath = Join-Path $PSScriptRoot 'pins.json'
if (-not (Test-Path $pinsPath)) { Write-Error "missing $pinsPath - it pins every third-party artifact"; exit 1 }
$pins = Get-Content $pinsPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$pins.singBox.version }
if (-not $Sha256) { $Sha256 = [string]$pins.singBox.zipSha256 }

function Get-Sha([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }

function Get-Verified {
  param([string]$Url, [string]$Sha256, [string]$Dest, [string]$Label)
  if ((Test-Path $Dest) -and -not $Force) {
    if ((Get-Sha $Dest) -eq $Sha256) { Write-Host "ok  $Label (pin matches)"; return }
    Write-Warning "$Label is present but does not match the pinned checksum - re-fetching to check upstream"
  }
  $tmp = "$Dest.download"
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -Uri $Url -OutFile $tmp
  $got = Get-Sha $tmp
  if ($got -ne $Sha256) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Error ("$Label checksum mismatch.`n  url:      $Url`n  expected: $Sha256`n  got:      $got`n" +
      "The upstream artifact changed (or was tampered with). Review the change, then update scripts\pins.json in the same commit.")
    exit 1
  }
  Move-Item -Force $tmp $Dest
  Write-Host "fetched $Label (pin matches)"
}

# --- routing rule-sets: pin matters as much as the binary's — a rule-set decides what bypasses the tunnel
foreach ($set in $pins.ruleSets.PSObject.Properties) {
  if ($set.Name -like '_*') { continue }
  Get-Verified -Url ([string]$set.Value.url) -Sha256 ([string]$set.Value.sha256) `
    -Dest (Join-Path $tools $set.Name) -Label $set.Name
}

# --- engine
if ((Test-Path $exe) -and -not $Force -and (Get-Sha $exe) -eq ([string]$pins.singBox.exeSha256)) {
  Write-Host "ok  sing-box.exe $Version (pin matches): $exe"
} else {
  if ((Test-Path $exe) -and -not $Force) {
    Write-Warning "sing-box.exe does not match the pinned hash for $Version - re-downloading"
  }
  $zip = Join-Path $env:TEMP "sing-box-$Version.zip"
  $asset = ([string]$pins.singBox.url) -replace '\{version\}', $Version
  Write-Host "downloading $asset"
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -Uri $asset -OutFile $zip
  $got = Get-Sha $zip
  if ($got -ne $Sha256.ToLower()) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Write-Error "sing-box zip checksum mismatch for ${Version}: got $got, expected $Sha256. Aborting."
    exit 1
  }
  Write-Host "checksum ok ($got)"
  $tmp = Join-Path $env:TEMP "sing-box-$Version-extract"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $tmp -Force
  $srcExe = Join-Path $tmp ((([string]$pins.singBox.exePathInZip) -replace '\{version\}', $Version) -replace '/', '\')
  $exePin = [string]$pins.singBox.exeSha256
  if ($exePin) {
    $dllGot = Get-Sha $srcExe
    if ($dllGot -ne $exePin) {
      Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
      Write-Error "sing-box.exe checksum mismatch after extraction: got $dllGot, expected $exePin. Aborting."
      exit 1
    }
  }
  Copy-Item $srcExe $exe -Force
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "installed: $exe"
}

# --- locally supplied assets that get bundled: report drift instead of packaging it silently
foreach ($asset in $pins.localAssets.PSObject.Properties) {
  if ($asset.Name -like '_*') { continue }
  $p = Join-Path $tools $asset.Name
  if (-not (Test-Path $p)) { continue }
  $got = Get-Sha $p
  if ($got -ne ([string]$asset.Value.sha256)) {
    Write-Warning "$($asset.Name) does not match the hash pinned in scripts\pins.json (got $got) - update the pin if the file was replaced on purpose."
  }
}
Write-Host 'note: tunnel-userlist.srs (the operator-curated IP list) is supplied/bundled separately.'
