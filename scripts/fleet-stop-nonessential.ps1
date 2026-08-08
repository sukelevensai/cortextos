<#
fleet-stop-nonessential.ps1

Stops cortextOS agents that are burning plan usage, while keeping an explicit KEEP
list running. Written 2026-08-06 during a usage spike: 80% of the weekly cap consumed,
with the fleet running ~4x its normal turn rate since a 00:34 UTC restart.

USE
    & '.\scripts\fleet-stop-nonessential.ps1'            # dry run
    & '.\scripts\fleet-stop-nonessential.ps1' -Execute   # actually stop
    & '.\scripts\fleet-stop-nonessential.ps1' -Execute -Keep agent-one,agent-two

WHY THIS SHAPE
  - Uses `cortextos stop <agent>`, the sanctioned CLI, NOT taskkill by name.
    A prior incident: killing by process name machine-wide also hits unrelated processes.
  - KEEP list is explicit and printed before anything happens. The PM work-order path
    must not go down; a prior silent outage on that path recorded what a
    gap there costs.
  - Dry run is the default. Nothing stops unless -Execute is passed.
  - Does NOT stop the daemon itself, so kept agents keep running and a restart is one
    `cortextos start <agent>` away.
#>

[CmdletBinding()]
param(
    [switch]$Execute,
    # Confirmed by the operator 2026-08-06: crm-ops IS the work-order worker and is the only
    # agent that must never go down. Everything else is restartable on demand.
    [string[]]$Keep = @('crm-ops')
)

$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '=== cortextOS fleet status BEFORE ===' -ForegroundColor Cyan
$before = & cortextos status 2>&1
$before | Out-String -Width 160 | Write-Host

# Parse agent names out of the status table. Column 1 is the name, column 2 the state.
$running = @()
foreach ($line in ($before -split "`n")) {
    if ($line -match '^\s{2}([a-z0-9][a-z0-9-]+?)\s*(running|stopped|errored)\s') {
        $running += [pscustomobject]@{ Name = $Matches[1]; State = $Matches[2] }
    }
}
$running = $running | Where-Object { $_.State -eq 'running' }

if (-not $running) {
    Write-Host 'Could not parse any running agents from `cortextos status`. Aborting.' -ForegroundColor Red
    exit 1
}

$toStop = $running | Where-Object { $Keep -notcontains $_.Name }
$kept = $running | Where-Object { $Keep -contains $_.Name }

Write-Host ''
Write-Host ('KEEP  ({0}):' -f $kept.Count) -ForegroundColor Green
foreach ($a in $kept) { Write-Host ('   + {0}' -f $a.Name) -ForegroundColor Green }
Write-Host ('STOP  ({0}):' -f $toStop.Count) -ForegroundColor Yellow
foreach ($a in $toStop) { Write-Host ('   - {0}' -f $a.Name) -ForegroundColor Yellow }

# Anything named in -Keep that is not actually running is worth shouting about: it may
# be the very worker the operator believes is protecting them.
$missing = $Keep | Where-Object { $running.Name -notcontains $_ }
if ($missing) {
    Write-Host ''
    Write-Host ('WARNING: these KEEP agents are NOT running: {0}' -f ($missing -join ', ')) -ForegroundColor Red
}

if (-not $Execute) {
    Write-Host ''
    Write-Host 'DRY RUN. Nothing was stopped.' -ForegroundColor Cyan
    Write-Host 'Re-run with -Execute to apply. Adjust with -Keep a,b,c.' -ForegroundColor Cyan
    exit 0
}

Write-Host ''
Write-Host '=== stopping ===' -ForegroundColor Yellow
$stopped = 0
foreach ($a in $toStop) {
    Write-Host ("  cortextos stop {0}" -f $a.Name)
    & cortextos stop $a.Name 2>&1 | Out-String -Width 160 | Write-Host
    if ($LASTEXITCODE -eq 0) { $stopped++ }
    else { Write-Host ("  FAILED: {0} (exit {1}) - continuing" -f $a.Name, $LASTEXITCODE) -ForegroundColor Red }
}

Write-Host ''
Write-Host '=== cortextOS fleet status AFTER ===' -ForegroundColor Cyan
& cortextos status 2>&1 | Out-String -Width 160 | Write-Host

Write-Host ''
Write-Host ("Stopped {0} of {1}. Kept: {2}" -f $stopped, $toStop.Count, ($kept.Name -join ', ')) -ForegroundColor Green
Write-Host 'Restart any agent with:  cortextos start <name>' -ForegroundColor DarkGray
