# restart-daemon-oneshot-payload.ps1
# HARDENED detached daemon restart payload (Codex 2-pass reviewed 2026-06-08).
# Runs under the Task Scheduler service (separate process tree) so it survives
# the analyst session being killed when the daemon stops.
#
# Invariant: NEVER leave the daemon STOPPED-and-not-STARTED without a loud FAILED
# marker. A result marker JSON records the new daemon PID so the resuming session
# verifies the chain. OK requires a FRESH (CreationDate >= start) daemon.js whose
# command line is THIS install's dist\daemon.js AND task state == Running.

$LogPath    = 'C:\Users\lukes\cortextos\scripts\daemon-restart.log'
$MarkerPath = 'C:\Users\lukes\cortextos\scripts\daemon-restart-result.json'
$TaskName   = 'cortextos-daemon-session0'
$DaemonRoot = 'C:\Users\lukes\cortextos\dist\daemon.js'
$StartedAt  = [DateTime]::UtcNow

function Log($m) { "$([DateTime]::UtcNow.ToString('o')) $m" | Out-File -FilePath $LogPath -Append -Encoding ascii }
function Write-Marker($obj) { ($obj | ConvertTo-Json -Compress) | Out-File -FilePath $MarkerPath -Encoding ascii }
# Match only THIS install's daemon (Codex p2 #1: exact command, not any daemon.js).
function Get-DaemonProcs {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like ('*' + $DaemonRoot + '*') }
}

# Codex p2 #3: mark IN_PROGRESS before any destructive step; top-level try/finally
# guarantees a terminal marker even on host termination.
Write-Marker ([ordered]@{ status='IN_PROGRESS'; started_at=$StartedAt.ToString('o') })
Log '==== RESTART-START (hardened one-shot, deploy upstream-9 weave) ===='

$newProc = $null
try {
    $before    = @(Get-DaemonProcs)
    $beforePids = @($before | ForEach-Object { $_.ProcessId })
    Log ("before daemon pids: " + ($beforePids -join ','))

    # Step 1: Stop the task (never abort the restart on a Stop error).
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log 'Stop-ScheduledTask issued' }
    catch { Log ("Stop-ScheduledTask error (continuing): " + $_.Exception.Message) }

    # Step 2: Verify task left Running before killing anything (Codex p1 #2).
    $stopped = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $st = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
        if ($st -and $st -ne 'Running') { $stopped = $true; Log ("task state=$st after ${i}s"); break }
    }
    if (-not $stopped) { Log 'WARN: task still Running after 15s; force-killing lingering daemon procs as last resort' }

    # Step 3: Kill lingering pre-restart daemon procs.
    foreach ($p in $before) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Log ("killed lingering daemon pid " + $p.ProcessId) }
        catch { Log ("could not kill pid " + $p.ProcessId + ": " + $_.Exception.Message) }
    }
    # Settle >60s so Telegram releases the killed pollers getUpdates locks before
    # the fresh daemons pollers start - else they 409 into the ~60s connection-release
    # window and re-deadlock (lantern group conflict incident 2026-06-25).
    Start-Sleep -Seconds 75

    # Step 4: Start with retry until a FRESH daemon proc exists.
    # Fresh = CreationDate >= StartedAt (Codex p2 #2: survives PID reuse).
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log ("Start-ScheduledTask attempt $attempt") }
        catch { Log ("Start attempt $attempt error: " + $_.Exception.Message) }
        for ($w = 0; $w -lt 12; $w++) {
            Start-Sleep -Seconds 1
            # CIM CreationDate is [DateTime] Kind=Local; $StartedAt is UtcNow. .NET
            # compares raw ticks ignoring Kind, so normalize to UTC or a UTC-N box
            # (Hawaii -10) false-fails the freshness test -> false FAILED + repeated
            # Starts (dual-daemon). Convert Local->UTC before the >= compare.
            $cand = @(Get-DaemonProcs | Where-Object { $_.CreationDate.ToUniversalTime() -ge $StartedAt })
            if ($cand.Count -ge 1) { $newProc = $cand[0]; break }
        }
        if ($newProc) { break }
        Log ("no fresh daemon after attempt $attempt; retrying")
    }
}
finally {
    # Step 5: terminal marker. OK requires BOTH fresh proc AND task Running (Codex p2 #1).
    $taskState = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    if ($newProc -and $taskState -eq 'Running') {
        Write-Marker ([ordered]@{ status='OK'; new_daemon_pid=$newProc.ProcessId; new_daemon_session=$newProc.SessionId; new_daemon_created=$newProc.CreationDate.ToString('o'); task_state="$taskState"; started_at=$StartedAt.ToString('o'); finished_at=([DateTime]::UtcNow.ToString('o')) })
        Log ("RESTART-DONE OK new daemon pid=" + $newProc.ProcessId + " session=" + $newProc.SessionId + " task=" + $taskState)
    } else {
        $pidTxt = if ($newProc) { $newProc.ProcessId } else { 'none' }
        Write-Marker ([ordered]@{ status='FAILED'; new_daemon_pid=$pidTxt; task_state="$taskState"; started_at=$StartedAt.ToString('o'); finished_at=([DateTime]::UtcNow.ToString('o')) })
        Log ("RESTART-FAILED freshProc=" + $pidTxt + " task=" + $taskState + " - MANUAL INTERVENTION NEEDED")
    }
}
