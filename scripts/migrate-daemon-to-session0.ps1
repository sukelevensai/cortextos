# migrate-daemon-to-session0.ps1
# ---------------------------------------------------------------------------
# CUTOVER: move cortextos-daemon from PM2 (interactive session 1, which makes
# agent claude.exe/bash spawns flash console windows) to a session-0 S4U
# scheduled task (no password, no desktop) so those spawns become invisible.
#
# The dashboard is LEFT on PM2 (it is not the flasher).
#
# RUN IN AN ELEVATED (Administrator) PowerShell:
#   & 'C:\Users\lukes\cortextos\scripts\migrate-daemon-to-session0.ps1'
#
# SELF-CONTAINED ON PURPOSE: stopping the old daemon kills all running agent
# sessions (incl. the analyst), so the analyst cannot guide this live. The
# script does the whole flip and verifies. The new daemon respawns the fleet.
#
# Ordering is deliberate: the PM2 daemon is stopped+deleted FIRST and verified
# gone BEFORE the new task starts, so two daemons never run at once (which would
# cause Telegram getUpdates conflicts + double cron dispatch).
#
# Reversible — rollback printed at the end. ASCII-only (PS 5.1).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$TaskName = 'cortextos-daemon-session0'
$Launcher = 'C:\Users\lukes\cortextos\scripts\daemon-svc-launch.cmd'
$EcoPath  = 'C:\Users\lukes\cortextos\ecosystem.config.js'

Write-Host "=== cortextOS daemon -> session-0 cutover ===" -ForegroundColor Cyan

# --- Preflight ---
if (-not (Test-Path $Launcher)) { throw "launcher not found: $Launcher" }
$pm2 = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2) {
    foreach ($c in @('C:\nvm4w\nodejs\pm2.cmd','C:\Users\lukes\AppData\Roaming\npm\pm2.cmd','C:\nvm4w\nodejs\pm2')) {
        if (Test-Path $c) { $pm2 = $c; break }
    }
}
if (-not $pm2) { throw "pm2 not found on PATH or known locations -- cannot safely stop the old daemon. ABORT." }
Write-Host "pm2: $pm2"

# --- STEP 1: stop + delete the PM2 daemon FIRST (no two-daemon overlap) ---
Write-Host "STEP 1: stopping + deleting PM2 'cortextos-daemon' (dashboard untouched)..." -ForegroundColor Cyan
& $pm2 stop cortextos-daemon
& $pm2 delete cortextos-daemon
& $pm2 save
Start-Sleep -Seconds 3
# Robust verify WITHOUT JSON parse (pm2 noise can break ConvertFrom-Json).
# Positive control: the dashboard MUST still appear -> proves jlist actually ran.
# Negative check: the daemon name MUST be absent -> proves the delete took.
# Abort on ANY uncertainty (a swallowed failure here = the double-daemon disaster).
$listText = (& $pm2 jlist) -join "`n"
if ($listText -notmatch 'cortextos-dashboard') {
    throw "pm2 jlist did not return the expected dashboard entry -- CANNOT verify daemon removal. ABORT. The new task was NOT started; run '& $pm2 list' manually. If the daemon is gone the fleet is down until you re-run or roll back."
}
if ($listText -match '"name"\s*:\s*"cortextos-daemon"') {
    throw "cortextos-daemon STILL in PM2 after delete -- ABORT to avoid two daemons running at once. The new task was NOT started. Investigate with '& $pm2 list' before retrying."
}
Write-Host "  PM2 daemon removed + saved (dashboard still present, jlist verified)." -ForegroundColor Green

# --- STEP 2: register the session-0 S4U task ---
Write-Host "STEP 2: registering session-0 task '$TaskName' (S4U, no password)..." -ForegroundColor Cyan
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute $Launcher -WorkingDirectory 'C:\Users\lukes\cortextos'
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
             -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "  Registered (auto-starts on boot, auto-restarts on crash)." -ForegroundColor Green

# --- STEP 3: start it now ---
Write-Host "STEP 3: starting the session-0 daemon..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Write-Host "  Started. Waiting 60s for boot + fleet respawn..." -ForegroundColor Gray
Start-Sleep -Seconds 60

# --- STEP 4: verify ---
Write-Host "STEP 4: verify" -ForegroundColor Cyan
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "  task state: $state"
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\daemon.js*' }
if ($proc) {
    foreach ($p in $proc) {
        $sid = try { (Get-Process -Id $p.ProcessId -ErrorAction Stop).SessionId } catch { '?' }
        Write-Host ("  daemon node PID {0} SessionId={1}  (want 0)" -f $p.ProcessId, $sid) -ForegroundColor Green
    }
} else {
    Write-Host "  (!) NO daemon process found in session 0 -> THE FLEET DID NOT COME BACK." -ForegroundColor Red
    Write-Host "  >>> RUN THE ROLLBACK BLOCK BELOW NOW. <<<" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== WHAT TO WATCH (next ~3 min) ===" -ForegroundColor Cyan
Write-Host "  - Agents re-heartbeat; the analyst should Telegram you 'back online from session 0'."
Write-Host "  - NO more console windows flashing on your desktop."
Write-Host "  - DEADLINE: if you do NOT get the analyst's 'back online from session 0' message"
Write-Host "    within 3 minutes, treat the cutover as FAILED and run the ROLLBACK block below."
Write-Host "  - The dashboard's daemon-health tile / a watcher may briefly show the daemon 'down'"
Write-Host "    because it left PM2 -- that is EXPECTED noise, not the real signal. The real signal"
Write-Host "    is the analyst Telegram + no flashing windows."
Write-Host ""
Write-Host "=== ROLLBACK (if anything is wrong) ===" -ForegroundColor Yellow
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  & '$pm2' start '$EcoPath' --only cortextos-daemon"
Write-Host "  & '$pm2' save"
