# Persistent strict-mode firewall guard. Explicit -Off restores the recorded prior policy.
# A process crash intentionally leaves the guard engaged. Run elevated.
param(
  [switch]$Off,
  [switch]$Status,
  [switch]$DryRun,
  [string]$ClientExe,
  [string]$EngineExe,
  [string]$TunnelAlias = 'magnetgate'
)
$ErrorActionPreference = 'Stop'
$group = 'magnetgate-strict-v1'
$stateDir = Join-Path $env:ProgramData 'magnetgate-firewall'
$stateFile = Join-Path $stateDir 'state.json'
function Get-GuardStatus {
  $recovery = Test-Path -LiteralPath $stateFile
  $protected = $false
  if ($recovery) {
    $bad = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled -ne 'True' -or $_.DefaultOutboundAction -ne 'Block' -or @($_.DisabledInterfaceAliases | Where-Object { $_ -and $_ -ne 'NotConfigured' }).Count })
    $allows = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Outbound -Action Allow -Enabled True)
    $external = @($allows | Where-Object { $_.Group -ne $group })
    $owned = @($allows | Where-Object { $_.Group -eq $group })
    $protected = $bad.Count -eq 0 -and $external.Count -eq 0 -and $owned.Count -ge 3
  }
  return [pscustomobject]@{ recoveryRequired = $recovery; protected = $protected }
}
if ($Status) { Get-GuardStatus | ConvertTo-Json -Compress; exit }
if ($DryRun) {
  if (-not $Off) {
    foreach ($exe in @($ClientExe,$EngineExe)) { if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Executable missing' } }
  }
  Write-Output 'Guard plan valid: preserve prior policy, disable existing outbound allow rules, allow only owned executables and TUN, block other outbound traffic. No policy changed.'
  exit
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Firewall guard requires Administrator' }
$mutex = New-Object Threading.Mutex($false, 'Global\magnetgate-firewall-v1')
if (-not $mutex.WaitOne(0)) { throw 'Firewall operation already running' }
try {
  if ($Off) {
    if (-not (Test-Path -LiteralPath $stateFile)) { exit }
    $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    foreach ($profile in $saved.profiles) {
      Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled -DefaultOutboundAction $profile.DefaultOutboundAction
    }
    foreach ($name in $saved.allowRules) {
      Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue | Enable-NetFirewallRule | Out-Null
    }
    Get-NetFirewallRule -PolicyStore PersistentStore -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Remove-Item -LiteralPath $stateFile
    Write-Output 'Firewall policy restored'
    exit
  }
  foreach ($exe in @($ClientExe,$EngineExe)) { if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Executable missing' } }
  if (-not (Test-Path -LiteralPath $stateFile)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    & icacls.exe $stateDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect firewall state directory' }
    $profiles = @(Get-NetFirewallProfile -PolicyStore PersistentStore | ForEach-Object { @{ Name = $_.Name.ToString(); Enabled = $_.Enabled.ToString(); DefaultOutboundAction = $_.DefaultOutboundAction.ToString() } })
    $allowRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Direction Outbound -Action Allow -Enabled True | Select-Object -ExpandProperty Name)
    $state = @{ profiles = $profiles; allowRules = $allowRules }
    $tempFile = Join-Path $stateDir 'state.tmp'
    [IO.File]::WriteAllText($tempFile, ($state | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempFile -Destination $stateFile -Force
  }
  # Only the recorded local policy is changed; domain/GPO allow rules cause failure below.
  $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  foreach ($name in $saved.allowRules) {
    Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue | Disable-NetFirewallRule | Out-Null
  }
  Get-NetFirewallRule -PolicyStore PersistentStore -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name "$group-client" -Group $group -DisplayName 'magnetgate rendezvous/native' -Direction Outbound -Action Allow -Program $ClientExe -Profile Any | Out-Null
  New-NetFirewallRule -Name "$group-engine" -Group $group -DisplayName 'magnetgate transport engine' -Direction Outbound -Action Allow -Program $EngineExe -Profile Any | Out-Null
  New-NetFirewallRule -Name "$group-loopback" -Group $group -DisplayName 'magnetgate loopback' -Direction Outbound -Action Allow -RemoteAddress '127.0.0.0/8','::1' -Profile Any | Out-Null
  # Interface aliases may not exist yet; add this rule once TUN is present on a subsequent call.
  if (Get-NetAdapter -Name $TunnelAlias -ErrorAction SilentlyContinue) {
    New-NetFirewallRule -Name "$group-tun" -Group $group -DisplayName 'magnetgate captured traffic' -Direction Outbound -Action Allow -InterfaceAlias $TunnelAlias -Profile Any | Out-Null
  }
  Set-NetFirewallProfile -Name Domain,Private,Public -Enabled True -DefaultOutboundAction Block
  $unexpected = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Outbound -Action Allow -Enabled True | Where-Object { $_.Group -ne $group })
  if ($unexpected.Count) { throw 'Managed/external outbound allow rules prevent strict enforcement; guard remains engaged. Use -Off to restore.' }
  $badProfile = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled -ne 'True' -or $_.DefaultOutboundAction -ne 'Block' })
  if ($badProfile.Count) { throw 'Effective firewall policy is not strict; use -Off to restore.' }
  if (-not (Get-GuardStatus).protected) { throw 'Effective firewall protection could not be verified; use -Off to restore.' }
  Write-Output 'Persistent firewall guard active'
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
