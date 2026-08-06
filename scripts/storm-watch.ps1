<#
storm-watch.ps1 - is the fleet talking to itself again?

Written 2026-08-06 after an agent-to-agent message storm burned ~80% of a weekly plan
cap overnight. Answers three questions in one shot:

  1. How many agent-to-agent messages in the last hour, and between whom?
  2. Is the storm guard actually stamping new messages (thread_root/depth present)?
  3. Has the guard refused anything?

Read-only. Safe to run any time.

    & 'C:\Users\lukes\cortextos\scripts\storm-watch.ps1'
    & 'C:\Users\lukes\cortextos\scripts\storm-watch.ps1' -Hours 4
#>

[CmdletBinding()]
param([int]$Hours = 1)

$ErrorActionPreference = 'Continue'
$cutoff = (Get-Date).ToUniversalTime().AddHours(-$Hours)

# Locate the live instance: the ctx root whose inbox tree was touched most recently.
$roots = Get-ChildItem "$env:USERPROFILE\.cortextos" -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'inbox') }
if (-not $roots) { Write-Host "No cortextos instance with an inbox/ found."; exit 0 }

$root = ($roots | Sort-Object { (Get-Item (Join-Path $_.FullName 'inbox')).LastWriteTime } -Descending |
    Select-Object -First 1).FullName
Write-Host "instance: $root" -ForegroundColor DarkGray
Write-Host "window:   last $Hours h (since $($cutoff.ToString('yyyy-MM-dd HH:mm')) UTC)" -ForegroundColor DarkGray
Write-Host ""

# Every message the fleet has produced, wherever it currently sits in the state machine.
$msgs = @()
foreach ($stage in @('inbox', 'inflight', 'processed')) {
    $dir = Join-Path $root $stage
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem $dir -Recurse -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime.ToUniversalTime() -gt $cutoff } |
        ForEach-Object {
            try {
                $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
                $msgs += [pscustomobject]@{
                    From = $m.from; To = $m.to; Depth = $m.depth
                    Root = $m.thread_root; Stage = $stage
                    Stamped = ($null -ne $m.thread_root)
                }
            } catch { }
        }
}

Write-Host ("AGENT MESSAGES in window: {0}" -f $msgs.Count) -ForegroundColor Cyan
$perHour = if ($Hours -gt 0) { [math]::Round($msgs.Count / $Hours, 1) } else { 0 }
Write-Host ("rate: {0}/hour   (quiet baseline was under 5/hr; the 2026-08-06 storm ran ~42/hr)" -f $perHour)
Write-Host ""

if ($msgs.Count -gt 0) {
    Write-Host "BY PAIR (cap is 10 per ordered pair per hour):"
    $msgs | Group-Object { "$($_.From) -> $($_.To)" } | Sort-Object Count -Descending |
        Select-Object -First 12 | ForEach-Object {
            $flag = if ($_.Count -ge 10) { '  <-- AT CAP' } elseif ($_.Count -ge 7) { '  <-- near cap' } else { '' }
            Write-Host ("  {0,4}  {1}{2}" -f $_.Count, $_.Name, $flag)
        }
    Write-Host ""

    # A message written by the new code carries thread_root. One without it was written
    # by an old process, which means the guard is not yet on that path.
    # @() around the filter on purpose: in PS 5.1 a pipeline yielding zero objects has
    # no .Count at all, so `$x.Count` renders as empty string rather than 0 - which
    # reads as "unknown" when it means "none". Same trap as the wrangler/JSON notes.
    $stamped = @($msgs | Where-Object { $_.Stamped }).Count
    $unstamped = $msgs.Count - $stamped
    Write-Host ("GUARD ACTIVE: {0} of {1} messages carry thread_root/depth" -f $stamped, $msgs.Count) -ForegroundColor $(if ($stamped -eq $msgs.Count) { 'Green' } else { 'Yellow' })
    if ($unstamped -gt 0) {
        Write-Host ("  {0} unstamped. Expected for anything sent before the guard was built;" -f $unstamped) -ForegroundColor DarkGray
        Write-Host "  persistent unstamped traffic means some send path is bypassing sendMessage." -ForegroundColor DarkGray
    }
    $depths = @($msgs | Where-Object { $null -ne $_.Depth } | ForEach-Object { [int]$_.Depth })
    $maxDepth = if ($depths.Count -gt 0) { ($depths | Measure-Object -Maximum).Maximum } else { 'n/a' }
    Write-Host ("deepest thread: {0} (cap 4)" -f $maxDepth)
}

# Refusals are logged as agent_message_refused events by src/cli/bus.ts.
# Path is analytics/events/<agent>/<date>.jsonl - NOT logs/. An earlier draft of this
# script grepped logs/, which does not exist, so it reported 0 refusals unconditionally.
# A monitor that cannot fail loudly is the same defect that let the 07-30 and 08-03
# storms pass unnoticed, so the missing-directory case shouts instead of printing 0.
Write-Host ""
$refusals = 0
$logRoot = Join-Path $root 'analytics\events'
if (-not (Test-Path $logRoot)) {
    Write-Host "WARNING: no analytics/events under $root - refusal count is UNKNOWN, not zero." -ForegroundColor Red
} else {
    Get-ChildItem $logRoot -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime.ToUniversalTime() -gt $cutoff } |
        ForEach-Object {
            $refusals += (Select-String -Path $_.FullName -Pattern 'agent_message_refused' -ErrorAction SilentlyContinue |
                Measure-Object).Count
        }
}
Write-Host ("GUARD REFUSALS in window: {0}" -f $refusals) -ForegroundColor $(if ($refusals -gt 0) { 'Yellow' } else { 'Green' })
if ($refusals -gt 0) {
    Write-Host "  A refusal is the guard working, not an error. Many refusals means agents are" -ForegroundColor DarkGray
    Write-Host "  still trying to argue and the underlying prompt behaviour needs attention." -ForegroundColor DarkGray
}

Write-Host ""
& cortextos status 2>&1 | Out-String -Width 140 | Write-Host
