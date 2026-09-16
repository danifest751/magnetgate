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

# Remove-AarClasses rewrites an AAR so that the nested jar no longer carries entries under $Prefix.
function Remove-AarClasses([string]$Aar, [string]$JarEntry, [string]$Prefix) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ('aar-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $rewritten = Join-Path $work 'rewritten.aar'
  try {
    $innerJar = Join-Path $work 'classes.jar'
    $innerJarOut = Join-Path $work 'classes-out.jar'

    $source = [System.IO.Compression.ZipFile]::OpenRead($Aar)
    try {
      $entry = $source.Entries | Where-Object { $_.FullName -eq $JarEntry } | Select-Object -First 1
      if (-not $entry) { throw "$Aar has no $JarEntry" }
      $stream = $entry.Open()
      $file = [System.IO.File]::Create($innerJar)
      try { $stream.CopyTo($file) } finally { $file.Close(); $stream.Close() }

      $inner = [System.IO.Compression.ZipFile]::OpenRead($innerJar)
      $out = [System.IO.Compression.ZipFile]::Open($innerJarOut, [System.IO.Compression.ZipArchiveMode]::Create)
      try {
        foreach ($item in $inner.Entries) {
          if ($item.FullName.StartsWith($Prefix)) { continue }
          $copy = $out.CreateEntry($item.FullName, [System.IO.Compression.CompressionLevel]::Optimal)
          $from = $item.Open()
          $to = $copy.Open()
          try { $from.CopyTo($to) } finally { $to.Close(); $from.Close() }
        }
      } finally { $out.Dispose(); $inner.Dispose() }

      $target = [System.IO.Compression.ZipFile]::Open($rewritten, [System.IO.Compression.ZipArchiveMode]::Create)
      try {
        foreach ($item in $source.Entries) {
          $copy = $target.CreateEntry($item.FullName, [System.IO.Compression.CompressionLevel]::NoCompression)
          $from = $item.Open()
          $to = $copy.Open()
          try {
            if ($item.FullName -eq $JarEntry) {
              $replacement = [System.IO.File]::OpenRead($innerJarOut)
              try { $replacement.CopyTo($to) } finally { $replacement.Close() }
            } else {
              $from.CopyTo($to)
            }
          } finally { $to.Close(); $from.Close() }
        }
      } finally { $target.Dispose() }
    } finally { $source.Dispose() }

    Move-Item -LiteralPath $rewritten -Destination $Aar -Force
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
