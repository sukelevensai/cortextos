<#
smith-quiet-and-pin.ps1

Two changes to the `smith` agent, decided by Luke 2026-08-16 after the box rebooted at
08:13Z and the daemon's boot trigger brought the whole fleet back up:

  1. QUIET  — disable all 5 enabled crons. smith fired 96 times/day from `heartbeat`
              (16,46 * * * *) and `check-approvals` (17,47 * * * *) alone, plus
              morning/evening/weekly reviews. Luke wants agents reactive: alive to
              answer Telegram, silent otherwise.
  2. PIN    — smith had NO config.json, so no --model flag reached the Claude Code
              spawn and it inherited Opus 5, the most expensive default. Pinned to
              claude-opus-4-8, matching the four lantern agents and call-coach.

WHAT QUIETING COSTS (state it, do not bury it)
    `check-approvals` is the ONLY path that Telegrams Luke when a NEW approval request
    or human task appears. With it off, approvals from crm-ops and the lantern agents
    accumulate unseen until someone runs fleet-seat-check.mjs by hand. Same for the
    morning/evening briefings. Every one is a single-command re-enable — see -Revert.

MECHANICS THAT FAIL SILENTLY
    `cortextos bus update-cron` resolves CTX_ROOT from process.cwd() when unset
    (src/bus/crons.ts:42), unlike every other command. And with CTX_ORG set it fails
    `cron '<name>' not found`. Three edits died that way on 2026-08-12. This script
    sets CTX_ROOT + CTX_AGENT_NAME and REMOVES CTX_ORG before every call.

    `list-crons` is NOT verification — it reads the same file the write touched. The
    proof is the absence of a fire in state/agents/smith/cron-execution.log past the
    next scheduled window. This script re-reads crons.json to confirm the write landed,
    and prints the log tail so the operator can check the real thing later.

USE
    & '.\scripts\smith-quiet-and-pin.ps1'           # dry run
    & '.\scripts\smith-quiet-and-pin.ps1' -Execute
    & '.\scripts\smith-quiet-and-pin.ps1' -Execute -Revert   # re-enable the 5 crons
#>

[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$Revert,
    [string]$Model = 'claude-opus-4-8'
)

$ErrorActionPreference = 'Continue'

$agent      = 'smith'
$ctxRoot    = Join-Path $env:USERPROFILE '.cortextos\default'
$cronsPath  = Join-Path $ctxRoot ".cortextOS\state\agents\$agent\crons.json"
$cronLog    = Join-Path $ctxRoot ".cortextOS\state\agents\$agent\cron-execution.log"
$configPath = Join-Path $env:USERPROFILE "cortextos\orgs\sitesmith-agency\agents\$agent\config.json"

# The 5 crons that were enabled as of 2026-08-16. shadow-batch was already disabled and
# is deliberately not touched in either direction.
$targets = @('heartbeat', 'check-approvals', 'morning-review', 'evening-review', 'weekly-review')
$desired = if ($Revert) { 'true' } else { 'false' }

Write-Host ''
Write-Host ("=== smith crons BEFORE ===") -ForegroundColor Cyan
if (-not (Test-Path $cronsPath)) { Write-Host "crons.json not found at $cronsPath. Aborting." -ForegroundColor Red; exit 1 }
$before = Get-Content $cronsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$beforeArr = if ($before -is [System.Array]) { $before } elseif ($before.crons) { @($before.crons) } else { @($before) }
foreach ($c in $beforeArr) {
    Write-Host ("  [{0}] {1,-18} {2}" -f $(if ($c.enabled -eq $false) { 'off' } else { 'ON ' }), $c.name, $c.schedule)
}

Write-Host ''
Write-Host ("ACTION: set enabled={0} on: {1}" -f $desired, ($targets -join ', ')) -ForegroundColor Yellow
if (-not $Revert) { Write-Host ("ACTION: pin model={0} in {1}" -f $Model, $configPath) -ForegroundColor Yellow }

if (-not $Execute) {
    Write-Host ''
    Write-Host 'DRY RUN. Nothing changed. Re-run with -Execute.' -ForegroundColor Cyan
    exit 0
}

# --- env discipline: CTX_ROOT + CTX_AGENT_NAME set, CTX_ORG removed ---
$env:CTX_ROOT       = $ctxRoot
$env:CTX_AGENT_NAME = $agent
if (Test-Path Env:CTX_ORG) { Remove-Item Env:CTX_ORG }

Copy-Item $cronsPath "$cronsPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

Write-Host ''
Write-Host '=== updating crons ===' -ForegroundColor Yellow
foreach ($t in $targets) {
    Write-Host ("  cortextos bus update-cron {0} {1} --enabled {2}" -f $agent, $t, $desired)
    & cortextos bus update-cron $agent $t --enabled $desired 2>&1 | Out-String -Width 200 | Write-Host
}

# --- confirm the write actually landed in the file ---
Write-Host ''
Write-Host '=== smith crons AFTER (re-read from disk) ===' -ForegroundColor Cyan
$after = Get-Content $cronsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$afterArr = if ($after -is [System.Array]) { $after } elseif ($after.crons) { @($after.crons) } else { @($after) }
$wrong = @()
foreach ($c in $afterArr) {
    $state = if ($c.enabled -eq $false) { 'off' } else { 'ON ' }
    Write-Host ("  [{0}] {1,-18} {2}" -f $state, $c.name, $c.schedule)
    if ($targets -contains $c.name) {
        $want = ($desired -eq 'true')
        $got  = ($c.enabled -ne $false)
        if ($want -ne $got) { $wrong += $c.name }
    }
}
if ($wrong) {
    Write-Host ('WRITE DID NOT LAND for: {0}' -f ($wrong -join ', ')) -ForegroundColor Red
} else {
    Write-Host ('All {0} target crons now enabled={1} on disk.' -f $targets.Count, $desired) -ForegroundColor Green
}

# --- model pin (forward direction only) ---
if (-not $Revert) {
    # Deliberately MINIMAL. loadAgentConfig (src/daemon/agent-manager.ts:1277) returns {}
    # when the file is absent, so every field is optional and smith has been running on
    # defaults. Adding timezone/working_directory here would silently shift cron firing
    # times and change the spawn cwd. Only the model is pinned.
    $cfg = @{ agent_name = $agent; enabled = $true; model = $Model }
    if (Test-Path $configPath) {
        Copy-Item $configPath "$configPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        $existing = Get-Content $configPath -Raw | ConvertFrom-Json
        foreach ($p in $existing.PSObject.Properties) { if (-not $cfg.ContainsKey($p.Name)) { $cfg[$p.Name] = $p.Value } }
        $cfg['model'] = $Model
    }
    $json = ($cfg | ConvertTo-Json -Depth 20)
    # No-BOM: operator-editable config, and loadAgentConfig strips only a leading BOM
    # while other readers in the tree do not.
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Host ''
    Write-Host ("=== wrote {0} ===" -f $configPath) -ForegroundColor Cyan
    Get-Content $configPath | Write-Host

    Write-Host ''
    Write-Host 'Restarting smith so the --model flag reaches the spawn...' -ForegroundColor Yellow
    & cortextos restart $agent 2>&1 | Out-String -Width 200 | Write-Host
}

Write-Host ''
Write-Host '=== cortextos status ===' -ForegroundColor Cyan
& cortextos status 2>&1 | Out-String -Width 200 | Write-Host

Write-Host ''
Write-Host 'Cron-log tail (the ONLY real proof a cron did or did not fire):' -ForegroundColor DarkGray
if (Test-Path $cronLog) { Get-Content $cronLog -Tail 5 | Write-Host } else { Write-Host '  (no cron-execution.log yet)' }
Write-Host ''
Write-Host 'Re-enable everything with:  & this-script -Execute -Revert' -ForegroundColor DarkGray
Write-Host 'Or one cron:  cortextos bus update-cron smith check-approvals --enabled true' -ForegroundColor DarkGray
