# restart-daemon-oneshot-payload.ps1
# HARDENED detached daemon restart payload.
# Runs under the Task Scheduler service (separate process tree) so it survives
# the analyst session being killed when the daemon stops.
#
# Invariant: NEVER leave the daemon STOPPED-and-not-STARTED without a loud FAILED
# marker. A result marker JSON records the new daemon PID so the resuming session
# verifies the chain. OK requires a FRESH daemon.pid (changed from before this
# run) whose resolved process is a live node.exe in Session 0, whose
# daemon-session0.log has grown (new bytes since this run started), AND task
# state == Running. A "[daemon] Running (pid: X)" line match in that new log
# content is captured too, but only as a non-gating `new_daemon_log_confirmed`
# field on the OK marker - see the Step 5 comment below for why it must not
# gate.
#
# Fragility 2 fix (2026-07, see AIAgency wiki/_handoff/2026-07-02-cortextos-
# bulletproof-plan.md). Two bugs in the prior version, both empirically
# confirmed:
#   1. Detection used WMI Win32_Process.CommandLine, which returns NULL
#      cross-session (non-elevated caller, different session than the
#      daemon). Every restart since 2026-06-18 false-failed at the Start
#      step because Get-DaemonProcs matched nothing even when a fresh daemon
#      had, in fact, booted (see daemon-restart.log 2026-06-18 / 2026-07-02
#      entries: "before daemon pids:" blank while a real daemon was running).
#      FIX: resolve the daemon from daemon.pid (bare int written by
#      index.ts's `writeFileSync(pidFile, String(process.pid))`) and verify
#      liveness with Get-Process -Id, which DOES work cross-session for a
#      non-elevated caller. Cross-check ProcessName -eq 'node' AND
#      SessionId -eq 0 so a PID recycled by an unrelated process is not
#      mistaken for the daemon.
#   2. Freshness used Win32_Process.CreationDate, which is also blank/
#      unreliable cross-session and caused false FAILED markers. FIX:
#      freshness = daemon.pid value CHANGED from the pre-restart value, the
#      new pid resolves live (node.exe, Session 0), AND daemon-session0.log
#      has grown (new bytes) since this run started - proves a fresh process
#      is actually writing to the log, not just that the pidfile was
#      rewritten. (A stricter "wait for the exact Running-line" gate was
#      tried and rejected - see Step 5 - because it can itself false-FAIL on
#      a large fleet boot or a log-sharing violation, the same failure class
#      this fix removes.)
#
# Also fixed: the old kill step (`Stop-Process -Id`) only killed the single
# node.exe, not its child tree - unverified whether Session-0 claude.exe
# agents cascade-die with their parent daemon. V1 (2026-07 spike) EMPIRICALLY
# CONFIRMED `taskkill /T /F /PID <root>` cascades and kills the whole tree
# cleanly on this box. The kill step below uses that, scoped to the single
# resolved daemon PID from THIS install - NEVER by image name (would hit
# unrelated node.exe/claude.exe processes elsewhere on the machine).
#
# -DetectOnly: read-only diagnostic mode. Resolves and reports the current
# daemon from daemon.pid via Get-Process. Does NOT stop the scheduled task,
# does NOT kill anything, does NOT start anything, and does NOT touch
# daemon-restart.log / daemon-restart-result.json. Safe to run against a live
# system at any time.

param(
    [switch]$DetectOnly
)

$LogPath      = 'C:\Users\lukes\cortextos\scripts\daemon-restart.log'
$MarkerPath   = 'C:\Users\lukes\cortextos\scripts\daemon-restart-result.json'
$TaskName     = 'cortextos-daemon-session0'
$PidFile      = 'C:\Users\lukes\.cortextos\default\daemon.pid'
$SessionLog   = 'C:\Users\lukes\cortextos\scripts\daemon-session0.log'
$CtxStateRoot = 'C:\Users\lukes\.cortextos\default\state'
$StartedAt    = [DateTime]::UtcNow

function Log($m) {
    if ($DetectOnly) { return }
    "$([DateTime]::UtcNow.ToString('o')) $m" | Out-File -FilePath $LogPath -Append -Encoding ascii
}
function Write-Marker($obj) {
    if ($DetectOnly) { return }
    ($obj | ConvertTo-Json -Compress) | Out-File -FilePath $MarkerPath -Encoding ascii
}

# Resolve the daemon from daemon.pid, NOT WMI CommandLine (see header). A
# bare-int pidfile is written by index.ts:293 on every daemon boot.
# Get-Process -Id is confirmed to work cross-session for a non-elevated
# caller; verify ProcessName -eq 'node' AND SessionId -eq 0 to guard against
# PID reuse by an unrelated process after the real daemon has exited.
function Resolve-DaemonProc {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = Get-Content -Path $PidFile -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $pidVal = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$pidVal)) { return $null }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ($proc.ProcessName -ne 'node' -or $proc.SessionId -ne 0) { return $null }
    return [pscustomobject]@{ Pid = $proc.Id; ProcessName = $proc.ProcessName; SessionId = $proc.SessionId }
}

if ($DetectOnly) {
    $found = Resolve-DaemonProc
    if ($found) {
        Write-Output ("DETECTED live daemon: pid=" + $found.Pid + " process=" + $found.ProcessName + " session=" + $found.SessionId + " (source: $PidFile)")
    } else {
        Write-Output ("NO live daemon resolved from $PidFile (missing/stale pidfile, or PID is not a node.exe in session 0)")
    }
    exit 0
}

# Mirrors agent-manager.ts:950-964 stopAll(), which writes a `.daemon-stop`
# marker in each agent's state dir BEFORE stopping it, so
# src/hooks/hook-crash-alert.ts reports a clean "daemon shutdown" instead of
# a false crash alarm on the next session boot. The daemon's own SIGTERM
# handler (index.ts ~403-404) never fires under an external `taskkill /F` -
# only a graceful Stop-ScheduledTask-that-actually-signals-SIGTERM would
# reach it, and this payload cannot rely on that - so the external payload
# must write the markers itself as the out-of-process equivalent of the
# internal path. Always called before any stop/kill attempt, unconditionally
# (matches stopAll()'s own unconditional pre-stop write).
function Write-DaemonStopMarkers {
    if (-not (Test-Path $CtxStateRoot)) {
        Log 'no state root found; skipping .daemon-stop marker write'
        return
    }
    $ts = 'daemon shutdown (external restart, oneshot payload)'
    $count = 0
    Get-ChildItem -Path $CtxStateRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $ts | Out-File -FilePath (Join-Path $_.FullName '.daemon-stop') -Encoding ascii -Force
            $count++
        } catch {
            Log ("could not write .daemon-stop marker for " + $_.Name + ": " + $_.Exception.Message)
        }
    }
    Log ("wrote .daemon-stop markers for $count agent state dir(s)")
}

# Codex p2 #3: mark IN_PROGRESS before any destructive step; top-level try/finally
# guarantees a terminal marker even on host termination.
Write-Marker ([ordered]@{ status='IN_PROGRESS'; started_at=$StartedAt.ToString('o') })
Log '==== RESTART-START (Fragility 2 hardened: daemon.pid detection + taskkill /T tree-kill) ===='

$newDaemon = $null
$newDaemonLogConfirmed = $false
try {
    $beforeDaemon = Resolve-DaemonProc
    if ($beforeDaemon) {
        Log ("before daemon pid: " + $beforeDaemon.Pid + " (session=" + $beforeDaemon.SessionId + ")")
    } else {
        Log 'before daemon pid: none resolved (missing/stale pidfile)'
    }

    # Baseline for the post-restart "log growing" freshness check.
    $logLenBefore = 0
    if (Test-Path $SessionLog) { $logLenBefore = (Get-Item $SessionLog).Length }

    # Step 1: write .daemon-stop markers BEFORE any stop/kill action.
    Write-DaemonStopMarkers

    # Step 2: Stop the task (never abort the restart on a Stop error). This
    # is load-bearing, not diagnostic: it resets the scheduled task's own
    # state to Ready so the later Start-ScheduledTask call is not a no-op
    # against a task that Windows still considers "Running" after the
    # explicit taskkill below (the daemon process dying does not by itself
    # update Task Scheduler's bookkeeping). The actual kill guarantee for
    # the daemon process tree does not depend on this succeeding, but a
    # Start after a Stop failure can still leave the task stuck Running.
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log 'Stop-ScheduledTask issued' }
    catch { Log ("Stop-ScheduledTask error (continuing): " + $_.Exception.Message) }

    # Step 3: poll task state (confirms Step 2 took effect; does not gate
    # the kill step below, which fires unconditionally on $beforeDaemon).
    $stopped = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $st = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
        if ($st -and $st -ne 'Running') { $stopped = $true; Log ("task state=$st after ${i}s"); break }
    }
    if (-not $stopped) { Log 'WARN: task still Running after 15s (continuing to explicit kill step)' }

    # Step 4: kill the resolved pre-restart daemon via taskkill /T /F.
    # V1-confirmed: cascades to the whole Session-0 claude.exe tree chained
    # to this pid. Own-root-scoped to $beforeDaemon.Pid only - NEVER by
    # image name (hard constraint: no image-name kill, ever).
    if ($beforeDaemon) {
        try {
            $tk = & taskkill /T /F /PID $beforeDaemon.Pid 2>&1
            Log ("taskkill /T /F /PID " + $beforeDaemon.Pid + " -> " + ($tk -join ' | '))
        } catch {
            Log ("taskkill error for pid " + $beforeDaemon.Pid + ": " + $_.Exception.Message)
        }
    } else {
        Log 'no live pre-restart daemon resolved from daemon.pid - nothing to kill'
    }

    # Settle >60s so Telegram releases the killed pollers' getUpdates locks
    # before the fresh daemon's pollers start - else they 409 into the ~60s
    # connection-release window and re-deadlock (lantern group conflict
    # incident 2026-06-25).
    Start-Sleep -Seconds 75

    # Step 5: Start with retry until a FRESH daemon is confirmed.
    # GATE (matches the task spec literally): daemon.pid CHANGED from
    # $beforeDaemon (or now resolves when it didn't before), resolves to a
    # confirmed-live node.exe in Session 0, AND daemon-session0.log has grown
    # (in bytes) since $logLenBefore. Size-growth is intentionally the gate,
    # NOT a match on the "[daemon] Running (pid: X)" line below - that line
    # is logged at index.ts:364, AFTER discoverAndStart() (line 362) boots
    # every agent's PTY. On an 18+-agent fleet that can plausibly exceed this
    # loop's ~60s window, and reading the log while the daemon holds it open
    # for append can hit a sharing violation - both would reproduce the exact
    # false-FAILED bug this fix addresses (see header) if used as the gate.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log ("Start-ScheduledTask attempt $attempt") }
        catch { Log ("Start attempt $attempt error: " + $_.Exception.Message) }
        for ($w = 0; $w -lt 12; $w++) {
            Start-Sleep -Seconds 1
            $after = Resolve-DaemonProc
            if (-not $after) { continue }
            if ($beforeDaemon -and $after.Pid -eq $beforeDaemon.Pid) { continue }

            $logGrew = $false
            if (Test-Path $SessionLog) {
                $logInfo = Get-Item $SessionLog
                if ($logInfo.Length -gt $logLenBefore) { $logGrew = $true }
            }
            if (-not $logGrew) { continue }

            # Gate satisfied.
            $newDaemon = $after

            # Best-effort, NON-GATING confirmation for the marker/log only:
            # look for the specific "[daemon] Running (pid: <newpid>)"
            # boot-complete line in the newly-appended tail. A read failure
            # here (sharing violation, line not there yet) just leaves
            # new_daemon_log_confirmed=false - it never flips $newDaemon back
            # to unconfirmed.
            try {
                $fs = [System.IO.File]::Open($SessionLog, 'Open', 'Read', 'ReadWrite')
                try {
                    $fs.Seek($logLenBefore, 'Begin') | Out-Null
                    $sr = New-Object System.IO.StreamReader($fs)
                    $delta = $sr.ReadToEnd()
                } finally { $fs.Dispose() }
                if ($delta -match [regex]::Escape("[daemon] Running (pid: $($after.Pid))")) {
                    $newDaemonLogConfirmed = $true
                }
            } catch {
                Log ("non-gating: could not read session log delta for Running-line confirmation: " + $_.Exception.Message)
            }
            break
        }
        if ($newDaemon) { break }
        Log ("no fresh daemon (pid changed + live + log grew) after attempt $attempt; retrying")
    }
}
finally {
    # Step 6: terminal marker. OK requires the fresh-daemon gate (pid
    # changed + live node/session0 + log grew) AND task state == Running
    # (same dual-condition contract as before). new_daemon_log_confirmed is
    # informational only (the non-gating Running-line match) - it does NOT
    # affect OK/FAILED.
    $taskState = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    if ($newDaemon -and $taskState -eq 'Running') {
        Write-Marker ([ordered]@{ status='OK'; new_daemon_pid=$newDaemon.Pid; new_daemon_session=$newDaemon.SessionId; new_daemon_log_confirmed=$newDaemonLogConfirmed; task_state="$taskState"; started_at=$StartedAt.ToString('o'); finished_at=([DateTime]::UtcNow.ToString('o')) })
        Log ("RESTART-DONE OK new daemon pid=" + $newDaemon.Pid + " session=" + $newDaemon.SessionId + " task=" + $taskState + " log_confirmed=" + $newDaemonLogConfirmed)
    } else {
        $pidTxt = if ($newDaemon) { $newDaemon.Pid } else { 'none' }
        Write-Marker ([ordered]@{ status='FAILED'; new_daemon_pid=$pidTxt; task_state="$taskState"; started_at=$StartedAt.ToString('o'); finished_at=([DateTime]::UtcNow.ToString('o')) })
        Log ("RESTART-FAILED freshProc=" + $pidTxt + " task=" + $taskState + " - MANUAL INTERVENTION NEEDED")
    }
}
