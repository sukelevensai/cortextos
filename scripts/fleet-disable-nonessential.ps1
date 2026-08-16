<#
fleet-disable-nonessential.ps1

DURABLE sibling of fleet-stop-nonessential.ps1.

WHY THIS EXISTS SEPARATELY FROM fleet-stop-nonessential.ps1
    `cortextos stop <agent>` kills the PTY but leaves `enabled: true` in
    config/enabled-agents.json. The daemon's scheduled task has a BOOT trigger, and
    src/daemon/agent-manager.ts:126-140 re-starts every agent that is not explicitly
    `enabled: false`. So a `stop` survives exactly until the next reboot.

    Observed 2026-08-16: the fleet was stopped 2026-08-15T01:53Z, the box hard-rebooted
    at 08:13:41Z, and all 13 agents came back up on their own. That is the failure this
    script closes.

    `cortextos disable <agent>` (src/cli/enable-agent.ts:260-291) does three things:
      1. sets enabled=false in enabled-agents.json (entry preserved, not deleted)
      2. writes state/<agent>/.user-disable so the SessionEnd hook does not fire a
         false CRASH alert
      3. stops the agent over daemon IPC
    Re-enable with `cortextos enable <agent>`.

USE
    & '.\scripts\fleet-disable-nonessential.ps1'            # dry run (default)
    & '.\scripts\fleet-disable-nonessential.ps1' -Execute
    & '.\scripts\fleet-disable-nonessential.ps1' -Execute -Keep smith,lantern-cfo

VERIFICATION
    `cortextos status` prints `running` with a blank PID after a successful stop, so its
    own output is not evidence. This script captures each agent's PID BEFORE disabling
    and re-checks it with Get-Process afterwards. That is the real-effect check.
#>

[CmdletBinding()]
param(
    # Set by Luke 2026-08-16: the Lantern client-facing agents plus smith. Everything
    # else is restartable on demand and should not be burning plan usage in the
    # background.
    [string[]]$Keep = @(
        'lantern-cfo',
        'lantern-command',
        'lantern-daryl-sidekick',
        'lantern-jay-sidekick',
        'smith'
    ),
    [switch]$Execute
)

$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '=== cortextOS fleet status BEFORE ===' -ForegroundColor Cyan
$before = & cortextos status 2>&1
$before | Out-String -Width 200 | Write-Host

# Parse the status table. The name column is not padded when the name is long
# (e.g. "lantern-daryl-sidekickrunning"), so the state is matched as an optional-space
# suffix rather than assuming whitespace separation.
$agents = @()
foreach ($line in ($before -split "`r?`n")) {
    if ($line -match '^\s{2}(?<name>[a-z0-9][a-z0-9-]+?)\s*(?<state>running|stopped|errored)\s+(?<pid>\d+)?') {
        $agents += [pscustomobject]@{
            Name  = $Matches['name']
            State = $Matches['state']
            Pid   = $(if ($Matches['pid']) { [int]$Matches['pid'] } else { $null })
        }
    }
}
$running = @($agents | Where-Object { $_.State -eq 'running' })

if (-not $running) {
    Write-Host 'Could not parse any running agents from `cortextos status`. Aborting.' -ForegroundColor Red
    exit 1
}

$toDisable = @($running | Where-Object { $Keep -notcontains $_.Name })
$kept      = @($running | Where-Object { $Keep -contains $_.Name })

Write-Host ''
Write-Host ('KEEP RUNNING ({0}):' -f $kept.Count) -ForegroundColor Green
foreach ($a in $kept) { Write-Host ('   + {0} (pid {1})' -f $a.Name, $a.Pid) -ForegroundColor Green }
Write-Host ('DISABLE ({0}):' -f $toDisable.Count) -ForegroundColor Yellow
foreach ($a in $toDisable) { Write-Host ('   - {0} (pid {1})' -f $a.Name, $a.Pid) -ForegroundColor Yellow }

# A KEEP agent that is not actually running may be the very worker the operator
# believes is protecting them. Shout about it.
$missing = @($Keep | Where-Object { $running.Name -notcontains $_ })
if ($missing) {
    Write-Host ''
    Write-Host ('WARNING: these KEEP agents are NOT running: {0}' -f ($missing -join ', ')) -ForegroundColor Red
}

if (-not $Execute) {
    Write-Host ''
    Write-Host 'DRY RUN. Nothing was disabled.' -ForegroundColor Cyan
    Write-Host 'Re-run with -Execute to apply. Adjust with -Keep a,b,c.' -ForegroundColor Cyan
    exit 0
}

# Back up enabled-agents.json before any mutation. It carries 18 entries and a
# botched write would unregister the whole fleet.
$enabledPath = Join-Path $env:USERPROFILE '.cortextos\default\config\enabled-agents.json'
$keysBefore = @()
if (Test-Path $enabledPath) {
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $enabledPath "$enabledPath.bak-$stamp" -Force
    Write-Host ''
    Write-Host ("Backed up enabled-agents.json -> enabled-agents.json.bak-{0}" -f $stamp) -ForegroundColor DarkGray
    $keysBefore = @((Get-Content $enabledPath -Raw | ConvertFrom-Json).PSObject.Properties.Name)
}

Write-Host ''
Write-Host '=== disabling ===' -ForegroundColor Yellow
$ok = 0
foreach ($a in $toDisable) {
    Write-Host ("  cortextos disable {0}" -f $a.Name)
    & cortextos disable $a.Name 2>&1 | Out-String -Width 200 | Write-Host
    if ($LASTEXITCODE -eq 0) { $ok++ }
    else { Write-Host ("  FAILED: {0} (exit {1}) - continuing" -f $a.Name, $LASTEXITCODE) -ForegroundColor Red }
}

# --- real-effect verification, not tool-output trust ---
# `cortextos disable` returns as soon as the daemon ACKs the IPC stop-agent message;
# the PTY teardown finishes a beat later. Checked immediately, every PID reads STILL
# ALIVE and the run looks like a total failure when in fact all of them died within a
# few seconds (observed 2026-08-16: 7/7 "alive" at t=0, 7/7 dead at t+30s). Poll
# instead of sampling once.
Write-Host ''
Write-Host '=== PID verification (Get-Process against pre-disable PIDs) ===' -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(30)
$pending  = @($toDisable | Where-Object { $_.Pid })
while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $pending = @($pending | Where-Object { Get-Process -Id $_.Pid -ErrorAction SilentlyContinue })
}

$stillAlive = @()
foreach ($a in $toDisable) {
    if (-not $a.Pid) { Write-Host ("  {0,-24} no PID captured - cannot verify" -f $a.Name) -ForegroundColor DarkYellow; continue }
    $p = Get-Process -Id $a.Pid -ErrorAction SilentlyContinue
    if ($p) {
        Write-Host ("  {0,-24} pid {1} STILL ALIVE after 30s" -f $a.Name, $a.Pid) -ForegroundColor Red
        $stillAlive += $a
    } else {
        Write-Host ("  {0,-24} pid {1} dead" -f $a.Name, $a.Pid) -ForegroundColor Green
    }
}
foreach ($a in $kept) {
    if (-not $a.Pid) { continue }
    $p = Get-Process -Id $a.Pid -ErrorAction SilentlyContinue
    if ($p) { Write-Host ("  {0,-24} pid {1} alive (kept)" -f $a.Name, $a.Pid) -ForegroundColor Green }
    else    { Write-Host ("  {0,-24} pid {1} DIED but was in KEEP" -f $a.Name, $a.Pid) -ForegroundColor Red }
}

# --- assert the registry survived intact ---
if ($keysBefore.Count -gt 0) {
    $keysAfter = @((Get-Content $enabledPath -Raw | ConvertFrom-Json).PSObject.Properties.Name)
    $dropped = @($keysBefore | Where-Object { $keysAfter -notcontains $_ })
    Write-Host ''
    if ($dropped) {
        Write-Host ("REGISTRY DAMAGE: {0} entries dropped: {1}" -f $dropped.Count, ($dropped -join ', ')) -ForegroundColor Red
        Write-Host ("Restore from {0}.bak-{1}" -f $enabledPath, $stamp) -ForegroundColor Red
    } else {
        Write-Host ("enabled-agents.json intact: {0}/{1} entries preserved." -f $keysAfter.Count, $keysBefore.Count) -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '=== cortextOS fleet status AFTER ===' -ForegroundColor Cyan
& cortextos status 2>&1 | Out-String -Width 200 | Write-Host

Write-Host ''
Write-Host ("Disabled {0} of {1}. Kept: {2}" -f $ok, $toDisable.Count, ($kept.Name -join ', ')) -ForegroundColor Green
if ($stillAlive) { Write-Host ("{0} agent(s) survived the disable - investigate before trusting this run." -f $stillAlive.Count) -ForegroundColor Red }
Write-Host 'Re-enable any agent with:  cortextos enable <name>' -ForegroundColor DarkGray
Write-Host 'Unlike `stop`, this survives a reboot.' -ForegroundColor DarkGray
