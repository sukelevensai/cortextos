# daemon-force-restart.ps1
# Force-recycle a wedged cortextos daemon that the scheduled task cannot control.
#
# WHY THIS EXISTS: the daemon (node dist/daemon.js) runs detached in Session 0.
# Stop-ScheduledTask / Start-ScheduledTask do NOT kill it (verified 2026-07-04:
# node process count stayed constant across a task Stop then Start). When the
# daemon wedges (Telegram getUpdates stuck in a 15s timeout loop, log stops
# advancing), the only recovery is to kill the actual node process tree and let
# the task relaunch a fresh one.
#
# RUN THIS IN YOUR OWN ELEVATED (Run as administrator) PowerShell window.
# Reason: reading and killing Session-0 process command lines needs elevation,
# and this is a destructive kill of production processes. Do not run it blind.

$ErrorActionPreference = 'Stop'

Write-Host "=== BEFORE ===" -ForegroundColor Cyan
$before = @(Get-Process node -ErrorAction SilentlyContinue)
Write-Host "node processes: $($before.Count)"

# 1. Find the real cortextos daemon by command line (needs elevation to read Session-0 cmdlines).
$daemons = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'cortextos\\dist\\daemon\.js' }

if (-not $daemons) {
  Write-Host "No dist/daemon.js process visible." -ForegroundColor Yellow
  Write-Host "If you are NOT running elevated, that is why (Session-0 cmdlines are hidden). Re-run as administrator." -ForegroundColor Yellow
  Write-Host "If you ARE elevated and it is genuinely absent, the daemon is already down. Skip to step 3 (Start-ScheduledTask)." -ForegroundColor Yellow
} else {
  foreach ($d in $daemons) {
    Write-Host "Found daemon PID $($d.ProcessId) (started $($d.CreationDate)). Killing its tree..." -ForegroundColor Yellow
    # /T kills the daemon and all child PTY / agent sessions it spawned.
    cmd /c "taskkill /PID $($d.ProcessId) /T /F"
  }
}

Start-Sleep -Seconds 5

# 2. Clear orphaned cortextos agent node processes (PTY sessions whose parent daemon
#    already died in a prior wedge). Targets ONLY nodes whose command line references
#    the cortextos tree, so it will not touch unrelated node processes (wrangler, etc.).
$orphans = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'cortextos' -and $_.CommandLine -notmatch 'dist\\daemon\.js' }
if ($orphans) {
  Write-Host "Clearing $($orphans.Count) orphaned cortextos agent node(s)..." -ForegroundColor Yellow
  foreach ($o in $orphans) { cmd /c "taskkill /PID $($o.ProcessId) /F" 2>$null | Out-Null }
}

Start-Sleep -Seconds 3
Write-Host "node processes after kill: $(@(Get-Process node -ErrorAction SilentlyContinue).Count)"

# 3. Relaunch a fresh daemon via the scheduled task (the sanctioned mechanism; never pm2 start).
Write-Host "=== restarting scheduled task ===" -ForegroundColor Cyan
Stop-ScheduledTask -TaskName "cortextos-daemon-session0" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "cortextos-daemon-session0"
Write-Host "task state: $((Get-ScheduledTask -TaskName 'cortextos-daemon-session0').State)"

# 4. Verify the fresh daemon boots and pollers register.
Write-Host "Waiting 40s for boot..." -ForegroundColor Cyan
Start-Sleep -Seconds 40
$log = "C:\Users\lukes\cortextos\scripts\daemon-session0.log"
Write-Host "log mtime: $((Get-Item $log).LastWriteTime)  (should be within the last minute)"
Write-Host "--- fresh poller starts ---"
Get-Content $log -Tail 120 | Where-Object { $_ -match 'poller started|Failed to start|conflict-self-die|Fatal' } | Select-Object -Last 20

Write-Host ""
Write-Host "If you see multiple 'Telegram poller started' lines and NO repeated conflict-self-die, the fleet is back." -ForegroundColor Green
Write-Host "Then message smith on Telegram to confirm it responds." -ForegroundColor Green
