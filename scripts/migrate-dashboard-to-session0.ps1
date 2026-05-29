# migrate-dashboard-to-session0.ps1
# ---------------------------------------------------------------------------
# CUTOVER: move cortextos-dashboard from PM2 (interactive session 1, where
# Next.js dev spawns next-server worker processes that flash console windows)
# to a session-0 S4U scheduled task (no password, no desktop) so those worker
# windows become invisible. Companion to migrate-daemon-to-session0.ps1, which
# already moved the agent daemon. After this, NOTHING cortextOS runs in the
# visible session 1 -> no more popping windows.
#
# RUN IN AN ELEVATED (Administrator) PowerShell:
#   & 'C:\Users\lukes\cortextos\scripts\migrate-dashboard-to-session0.ps1'
#
# SAFE TO GUIDE LIVE: unlike the daemon cutover, stopping the dashboard does
# NOT kill the analyst (the analyst now runs under the session-0 daemon). The
# only thing that goes down is the localhost:3000 web UI, for ~30-45s.
#
# Ordering: stop+delete the PM2 dashboard FIRST and verify its 'next' process
# is gone from session 1 BEFORE starting the session-0 task, so port 3000 is
# free and two dashboards never bind it at once.
#
# Reversible - rollback printed at the end. ASCII-only (PS 5.1).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$TaskName = 'cortextos-dashboard-session0'
$Launcher = 'C:\Users\lukes\cortextos\scripts\dashboard-svc-launch.cmd'
$EcoPath  = 'C:\Users\lukes\cortextos\ecosystem.config.js'
$DashDir  = 'C:\Users\lukes\cortextos\dashboard'

Write-Host "=== cortextOS dashboard -> session-0 cutover ===" -ForegroundColor Cyan

# --- Preflight ---
if (-not (Test-Path $Launcher)) { throw "launcher not found: $Launcher" }
$pm2 = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2) {
    foreach ($c in @('C:\nvm4w\nodejs\pm2.cmd','C:\Users\lukes\AppData\Roaming\npm\pm2.cmd','C:\nvm4w\nodejs\pm2')) {
        if (Test-Path $c) { $pm2 = $c; break }
    }
}
if (-not $pm2) { throw "pm2 not found on PATH or known locations -- cannot safely stop the old dashboard. ABORT." }
Write-Host "pm2: $pm2"

# Helper: is the PM2 'next dev' dashboard process alive in session 1?
function Get-Session1NextProc {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*dashboard\node_modules\next*' -and $_.SessionId -eq 1 }
}

$before = Get-Session1NextProc
if ($before) {
    foreach ($p in $before) { Write-Host ("  pre: dashboard next PID {0} SessionId={1}" -f $p.ProcessId, $p.SessionId) -ForegroundColor Gray }
} else {
    Write-Host "  (note) no session-1 'next' dashboard process found pre-cutover; continuing." -ForegroundColor Yellow
}

# --- STEP 1: stop + delete the PM2 dashboard FIRST ---
Write-Host "STEP 1: stopping + deleting PM2 'cortextos-dashboard'..." -ForegroundColor Cyan
& $pm2 stop cortextos-dashboard
& $pm2 delete cortextos-dashboard
& $pm2 save
Start-Sleep -Seconds 4

# Verify removal by PROCESS DISAPPEARANCE (most reliable; PM2 is now empty so
# we cannot use a positive-control entry like the daemon script did).
$still = Get-Session1NextProc
if ($still) {
    # PM2 may have left a child; try a hard stop of those PIDs, then re-check.
    foreach ($p in $still) {
        Write-Host ("  next PID {0} still alive after pm2 delete; stopping it..." -f $p.ProcessId) -ForegroundColor Yellow
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Seconds 3
    $still = Get-Session1NextProc
}
if ($still) {
    throw "session-1 'next' dashboard process STILL alive after delete+kill -- ABORT to avoid two dashboards binding port 3000. The new task was NOT started. Investigate with '& $pm2 list' and Get-Process node before retrying."
}
Write-Host "  PM2 dashboard removed; no 'next' process left in session 1." -ForegroundColor Green

# --- STEP 2: register the session-0 S4U task ---
Write-Host "STEP 2: registering session-0 task '$TaskName' (S4U, no password)..." -ForegroundColor Cyan
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute $Launcher -WorkingDirectory $DashDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
             -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "  Registered (auto-starts on boot, auto-restarts on crash)." -ForegroundColor Green

# --- STEP 3: start it now ---
Write-Host "STEP 3: starting the session-0 dashboard..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Write-Host "  Started. Waiting 45s for Next.js to boot + bind port 3000..." -ForegroundColor Gray
Start-Sleep -Seconds 45

# --- STEP 4: verify ---
Write-Host "STEP 4: verify" -ForegroundColor Cyan
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "  task state: $state"

$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dashboard\node_modules\next*' }
$inSession0 = $false
if ($proc) {
    foreach ($p in $proc) {
        $sid = try { (Get-Process -Id $p.ProcessId -ErrorAction Stop).SessionId } catch { '?' }
        $color = if ($sid -eq 0) { 'Green' } else { 'Red' }
        if ($sid -eq 0) { $inSession0 = $true }
        Write-Host ("  dashboard next PID {0} SessionId={1}  (want 0)" -f $p.ProcessId, $sid) -ForegroundColor $color
    }
} else {
    Write-Host "  (!) NO dashboard process found -> it did NOT start in session 0." -ForegroundColor Red
}

# Port liveness: TCP connect to 3000 (port bound = next is up, even if first
# compile is still warming).
$portUp = $false
try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', 3000)
    $portUp = $c.Connected
    $c.Close()
} catch { $portUp = $false }
$pcolor = if ($portUp) { 'Green' } else { 'Yellow' }
Write-Host ("  port 3000 listening: {0}" -f $portUp) -ForegroundColor $pcolor

Write-Host ""
if ($inSession0 -and $portUp) {
    Write-Host "RESULT: GREEN -- dashboard is in session 0 and serving on 3000." -ForegroundColor Green
} else {
    Write-Host "RESULT: NOT FULLY VERIFIED -- check the lines above." -ForegroundColor Yellow
    Write-Host "  If the dashboard process is missing OR port 3000 is dead after ~60s more, ROLLBACK below." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== WHAT TO WATCH ===" -ForegroundColor Cyan
Write-Host "  - NO more next-server / console windows flashing on your desktop."
Write-Host "  - Dashboard still loads in your browser at http://localhost:3000 (give it ~30s to compile on first hit)."
Write-Host ""
Write-Host "=== ROLLBACK (if anything is wrong) ===" -ForegroundColor Yellow
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  & '$pm2' start '$EcoPath' --only cortextos-dashboard"
Write-Host "  & '$pm2' save"
