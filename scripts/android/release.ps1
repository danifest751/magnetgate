#Requires -Version 5.1
<#
.SYNOPSIS
  Publishes one build: the package onto the node that serves it, the manifest onto every node that
  announces it, with a sign of success demanded at each step.

.DESCRIPTION
  This was three commands typed by hand (HANDOFF-android.md §11), and three commands typed by hand are
  three commands to get wrong at midnight: the package copied and the unit still pointing at the old
  file, the manifest updated on one node and not the other, a build published from a working tree that
  no commit describes. Every one of those leaves a group of phones on a build nobody can reproduce, and
  none of them announces itself - the client simply never offers an update, or offers one that 404s.

  So each step here ends in a question with an affirmative answer:

    1. the tree is clean            the version code is the commit count; a dirty build is not a release
    2. the package arrived whole    sha256 read back from the node equals the one computed here
    3. the distributor serves it    a Range request to the very URL the manifest will carry answers 206
                                    with the expected total size - not "the service is active"
    4. every node got the manifest  the file read back from each node hashes to what was written here

  Addresses are parameters and never defaults: this repository is public and scripts/check-hygiene.mjs
  rejects real host addresses on the way into a commit. The URL of the new package is not typed either -
  it is learned from the manifest already published, so the secret path lives on the nodes and in the
  sealed offer, and nowhere in this file.

  The build is debuggable on purpose and the publisher is told so in as many words (--allow-debuggable):
  every phone in this group runs a debug-signed build, because Android installs an update only over the
  same signature. See §11 and trap 104 before changing that.

.EXAMPLE
  powershell -File scripts/android/release.ps1 -PackageNode <ip> -Nodes <ip>,<ip>

.EXAMPLE
  # print every remote command without running one, which is how a first run should look
  powershell -File scripts/android/release.ps1 -PackageNode <ip> -Nodes <ip>,<ip> -Url http://<ip>:45443/<path>/magnetgate-208.apk -DryRun
#>
[CmdletBinding()]
param(
  # The node that stores and serves the package. It must be one of -Nodes.
  [Parameter(Mandatory = $true)][string]$PackageNode,
  # Every node that announces the manifest. All of them, or phones reaching the other one see the old build.
  [Parameter(Mandatory = $true)][string[]]$Nodes,
  [string]$User = 'root',
  [string]$Key = 'key\oflx_key',
  [string]$Unit = 'magnetgate-update',
  [string]$PackageDir = '/opt/magnetgate-updates',
  [string]$ManifestFile = '/etc/magnetgate-update.json',
  # Where the new package will answer. Empty means "the same shape as the published manifest, with the
  # file name swapped", which is the normal case and keeps the secret path out of this repository.
  [string]$Url = '',
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $root 'app-android'
$apk = Join-Path $project 'app\build\outputs\apk\debug\app-arm64-v8a-debug.apk'

if (-not (Test-Path -LiteralPath $project)) { throw "app project not found under $project" }

# `powershell -File release.ps1 -Nodes a,b` hands the list over as one string, so the comma is split
# here rather than trusted to the binder: a run that announced to one node and thought it announced to
# two is exactly the failure this script exists to prevent.
$Nodes = @($Nodes | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $Nodes) { throw '-Nodes is empty' }
if ($Nodes -notcontains $PackageNode) { throw "-PackageNode $PackageNode is not in -Nodes: the node that serves the package must also announce it" }

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'sdk\android-sdk' }
# The key lives outside the checkout (it is exactly what check-hygiene.mjs refuses to let in), so a
# relative -Key is looked for beside the repository as well as inside it.
$keyPath = $Key
if (-not [System.IO.Path]::IsPathRooted($Key)) {
  $candidates = @((Join-Path $root $Key), (Join-Path (Split-Path -Parent $root) $Key))
  $keyPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $keyPath) { throw "ssh key not found, looked in: $($candidates -join ', ')" }
}
if (-not (Test-Path -LiteralPath $keyPath)) { throw "ssh key not found at $keyPath" }

function Say([string]$message) { Write-Host "[release] $message" }

# ssh, scp and gradle write progress to stderr, which PowerShell 5.1 turns into terminating errors
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

$script:planned = @()
function Remote([string]$node, [string]$command) {
  $script:planned += "ssh ${User}@${node} `"$command`""
  if ($DryRun) { return '' }
  $output = (Invoke-Native 'ssh' @('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', "$User@$node", $command)) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "ssh $node failed (exit $LASTEXITCODE): $output" }
  return $output.Trim()
}

function Copy-Up([string]$node, [string]$from, [string]$to) {
  $script:planned += "scp `"$from`" ${User}@${node}:$to"
  if ($DryRun) { return }
  Invoke-Native 'scp' @('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', $from, "${User}@${node}:$to") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp to $node failed (exit $LASTEXITCODE)" }
}

function Copy-Down([string]$node, [string]$from, [string]$to) {
  $script:planned += "scp ${User}@${node}:$from `"$to`""
  if ($DryRun) { return $false }
  Invoke-Native 'scp' @('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', "${User}@${node}:$from", $to) | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Hash-Of([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() }

# ---------------------------------------------------------------- 1. the tree is clean
# The version code is the number of commits (app/build.gradle.kts), so a package built from a dirty tree
# carries a number that already belongs to something else and a name no checkout can reproduce. A phone
# that then reports a crash in build 208 would be describing a build that exists on one laptop.
$dirty = (Invoke-Native 'git' @('status', '--porcelain') $root) -join "`n"
if ($dirty.Trim()) {
  Say 'the working tree is not clean:'
  Write-Host $dirty
  throw 'commit or stash first: the build number is the commit count, and a dirty build is not a release'
}
$head = ((Invoke-Native 'git' @('rev-parse', '--short', 'HEAD') $root) -join '').Trim()
$ahead = ((Invoke-Native 'git' @('rev-list', '--count', '@{u}..HEAD') $root) -join '').Trim()
if ($ahead -and $ahead -ne '0') { Say "warning: $ahead commit(s) are not pushed; the source of this build is only on this machine" }

# ---------------------------------------------------------------- 2. build
if (-not $SkipBuild) {
  Say "building at $head"
  Invoke-Native (Join-Path $project 'gradlew.bat') @('--no-daemon', 'app:assembleDebug') $project | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "gradle failed (exit $LASTEXITCODE)" }
}
if (-not (Test-Path -LiteralPath $apk)) { throw "no package at $apk (drop -SkipBuild)" }

# What the package says about itself, asked of the package - not of the file name (publish-update.mjs
# makes the same point at greater length).
$tools = Join-Path $sdk 'build-tools'
$latest = (Get-ChildItem -LiteralPath $tools -Directory | Sort-Object Name | Select-Object -Last 1).FullName
$aapt = Join-Path $latest 'aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) { throw "aapt2 not found at $aapt (set ANDROID_SDK_ROOT)" }
$badging = (Invoke-Native $aapt @('dump', 'badging', $apk)) -join "`n"
$code = [int]([regex]::Match($badging, "versionCode='(\d+)'").Groups[1].Value)
$name = [regex]::Match($badging, "versionName='([^']+)'").Groups[1].Value
if ($code -lt 1 -or -not $name) { throw 'the package does not name a version' }
if ($name -like '*-dirty') { throw "the package names itself ${name}: it was built from a tree that had uncommitted changes" }
$bytes = (Get-Item -LiteralPath $apk).Length
$sha = Hash-Of $apk
$file = "magnetgate-$code.apk"
Say "build $code ($name), $bytes B, sha256 $sha"

# ---------------------------------------------------------------- what is published now
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("magnetgate-release-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $temp | Out-Null
$currentFile = Join-Path $temp 'published.json'
$got = Copy-Down $PackageNode $ManifestFile $currentFile
$current = $null
if ($got -and (Test-Path -LiteralPath $currentFile)) {
  $current = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
  Say "published now: build $($current.vc) ($($current.vn))"
  if ([int]$current.vc -ge $code) { throw "build $code is not newer than the published $($current.vc): Android would refuse it anyway" }
}

if (-not $Url) {
  if ($DryRun -and -not $current) { throw 'in -DryRun there is no manifest to learn the URL from: pass -Url' }
  if (-not $current) { throw "nothing is published at $ManifestFile yet, so the URL cannot be learned: pass -Url" }
  # Only the file name changes; the host, the port and the secret path are whatever is already serving.
  $Url = [regex]::Replace([string]$current.url, '[^/]+$', $file)
}
if ($Url -notmatch "/$([regex]::Escape($file))$") { throw "-Url ends in something other than $file, so the manifest would point at a different package" }
Say "url $Url"

# ---------------------------------------------------------------- 3. the package arrives whole
# 88 MB over a link that is not always good: if the node already holds these exact bytes (a first run
# that got this far and failed later), sending them again proves nothing the hash has not proved.
$held = ''
if (-not $DryRun) { $held = (Remote $PackageNode "sha256sum $PackageDir/$file 2>/dev/null | cut -c1-64").Trim() }
if ($held -eq $sha) {
  Say "  PASS  the node already holds these bytes ($sha)"
} else {
  Copy-Up $PackageNode $apk "$PackageDir/$file"
  if (-not $DryRun) {
    $remote = (Remote $PackageNode "sha256sum $PackageDir/$file").Split(' ')[0]
    if ($remote -ne $sha) { throw "the package on the node hashes to $remote, not ${sha}: the copy is not the file that was built" }
    Say "  PASS  the node holds the same bytes ($sha)"
  }
}

# ---------------------------------------------------------------- 4. the distributor serves it
# The unit names one file and answers 404 for everything else, which is the point of it; so the name in
# the unit is swapped rather than added, and the old package is left on disk (a phone halfway through a
# download of it keeps its Range requests answered until the service restarts, and disk is cheap).
#
# No double quotes reach ssh, and no shell variable crosses a command boundary: PowerShell 5.1 re-quotes
# the arguments it hands a native program and eats them, which turned `sed -i "s|$old|$new|g"` into three
# pipes and a sed that never ran (the Range check below is what caught it - the service was active and
# serving the previous package).
$unitPath = "/etc/systemd/system/$Unit.service"
$old = (Remote $PackageNode "grep -o 'magnetgate-[0-9]*\.apk' $unitPath | head -1").Trim()
if (-not $DryRun) {
  if (-not $old) { throw "no package name in $unitPath on ${PackageNode}: nothing to swap" }
  if ($old -ne $file) {
    Remote $PackageNode "sed -i s@$old@$file@g $unitPath" | Out-Null
    $named = (Remote $PackageNode "grep -c $file $unitPath").Trim()
    if ([int]$named -lt 1) { throw "$unitPath still does not name $file after the swap" }
  }
}
$active = Remote $PackageNode "systemctl daemon-reload; systemctl restart $Unit; sleep 1; systemctl is-active $Unit"
if (-not $DryRun) {
  if ($active -ne 'active') { throw "$Unit is '$active' after the restart" }
  # Not "the service is up": the URL the manifest is about to carry has to answer, with the size of the
  # package that was just hashed. A distributor pointing at the previous file is active too.
  $headers = Remote $PackageNode "curl -sS -r 0-0 -D - -o /dev/null '$Url' | tr -d '\r'"
  $range = [regex]::Match($headers, 'Content-Range:\s*bytes 0-0/(\d+)')
  if (-not $range.Success) { throw "the distributor did not answer a Range request for the new package:`n$headers" }
  if ([int64]$range.Groups[1].Value -ne $bytes) { throw "the URL serves $($range.Groups[1].Value) B, the package is $bytes B" }
  Say "  PASS  $Url answers 206 for $bytes B"
}

# ---------------------------------------------------------------- 5. announce
$manifest = Join-Path $temp 'magnetgate-update.json'
$publish = @('scripts/publish-update.mjs', '--apk', $apk, '--url', $Url, '--out', $manifest, '--allow-debuggable')
$script:planned += "node $($publish -join ' ')"
if (-not $DryRun) {
  Invoke-Native 'node' $publish $root | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "publish-update failed (exit $LASTEXITCODE)" }
  $manifestHash = Hash-Of $manifest
  foreach ($node in $Nodes) {
    Copy-Up $node $manifest $ManifestFile
    $readBack = (Remote $node "sha256sum $ManifestFile").Split(' ')[0]
    if ($readBack -ne $manifestHash) { throw "$node holds a different manifest ($readBack): it would announce something else" }
    Say "  PASS  $node announces build $code"
  }
} else {
  foreach ($node in $Nodes) { $script:planned += "scp <manifest> ${User}@${node}:$ManifestFile" }
}

# ---------------------------------------------------------------- what happens next
if ($DryRun) {
  Say 'dry run; nothing was changed. What it would do:'
  $script:planned | ForEach-Object { Write-Host "  $_" }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  return
}

Say ''
Say "released build $code ($name) from $head"
Say "  package  $PackageDir/$file on $PackageNode"
Say "  manifest $ManifestFile on $($Nodes -join ', ')"
Say ''
Say 'The exit re-reads the manifest for every offer it seals, so nothing needs restarting. Phones see'
Say 'the card within a cycle, download through their own tunnel and check the digest; a person taps'
Say 'install. Nothing installs itself, and no phone installs anything that does not match the hash above.'
Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
