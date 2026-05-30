# register-pty-test-task.ps1
# ---------------------------------------------------------------------------
# Registers + runs the ISOLATED session-0 ConPTY viability probe
# (session0-pty-test.js) as a one-shot Scheduled Task that runs as COMEUP\lukes
# with "run whether logged on or not" (= session 0, no interactive desktop,
# user profile loaded). This reproduces the run context the production NSSM
# service will have, so the probe result transfers.
#
# RUN THIS IN YOUR OWN PowerShell window (it prompts for your Windows password
# via Get-Credential -- Claude's sandbox cannot enter interactive prompts).
#
#   & 'C:\Users\lukes\cortextos\scripts\register-pty-test-task.ps1'
#
# It does NOT touch PM2 or the live daemon. Fully reversible -- cleanup command
# printed at the end. ASCII-only on purpose (PS 5.1 mis-decodes non-ASCII).
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$TaskName   = 'cortextos-pty-test'
$Node       = 'C:\nvm4w\nodejs\node.exe'
$Script     = 'C:\Users\lukes\cortextos\scripts\session0-pty-test.js'
$WorkDir    = 'C:\Users\lukes\cortextos'
$CtxRoot    = if ($env:CTX_ROOT) { $env:CTX_ROOT } else { 'C:\Users\lukes\.cortextos\default' }
$ControlLog = Join-Path $CtxRoot 'session0-pty-test-control.log'
$TaskLog    = Join-Path $CtxRoot 'session0-pty-test-task.log'

Write-Host "=== session-0 ConPTY probe ===" -ForegroundColor Cyan

# Preflight: confirm the pieces exist before asking for a password.
if (-not (Test-Path $Node))   { throw "node.exe not found at $Node" }
if (-not (Test-Path $Script)) { throw "test script not found at $Script" }

# -------------------------------------------------------------------------
# STEP 1 -- CONTROL run (interactive, your own session). Establishes the
# baseline: if THIS fails, the harness/claude-flags are broken and the
# session-0 task result would be meaningless. Expected SessionId=1.
# -------------------------------------------------------------------------
Write-Host "STEP 1/2: control run (your interactive session, expect SessionId=1)..." -ForegroundColor Cyan
& $Node $Script control
Write-Host "  control run finished (exit $LASTEXITCODE)." -ForegroundColor DarkGray

# Remove any prior copy of the test task (idempotent).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing prior '$TaskName' task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# -------------------------------------------------------------------------
# STEP 2 -- TASK run (session 0 via "run whether logged on or not").
# This is the production-fidelity test. The probe MUST log SessionId=0.
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "STEP 2/2: session-0 task run (run-as lukes, MUST show SessionId=0)..." -ForegroundColor Cyan

# Secure password prompt -- used only to register a run-as-lukes batch logon.
$cred = Get-Credential -UserName "$env:COMPUTERNAME\lukes" `
    -Message "Enter the Windows password for $env:COMPUTERNAME\lukes (registers the session-0 test task only)"

# Pass the "task" label so this run writes its own log/sentinel (no clobber of control).
$action   = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`" task" -WorkingDirectory $WorkDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

Write-Host "Registering '$TaskName' (run-as $($cred.UserName), session 0, profile loaded)..." -ForegroundColor Cyan
Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

Write-Host "Starting the probe..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName

# Wait for it to finish (cap ~4 min).
$deadline = (Get-Date).AddMinutes(4)
do {
    Start-Sleep -Seconds 5
    $info  = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    Write-Host "  state=$state  lastResult=$($info.LastTaskResult)"
} while ($state -eq 'Running' -and (Get-Date) -lt $deadline)

function Show-Log($label, $logPath) {
    Write-Host ""
    Write-Host "=== $label LOG ($logPath) ===" -ForegroundColor Green
    if (Test-Path $logPath) {
        Get-Content $logPath
    } else {
        Write-Host "(!) Log not found at $logPath." -ForegroundColor Red
        if ($label -eq 'TASK (session 0)') {
            Write-Host "    The run-as account could not write the log -- a profile/permission finding in itself." -ForegroundColor Red
        }
    }
}

Show-Log 'CONTROL (your session)' $ControlLog
Show-Log 'TASK (session 0)'       $TaskLog

Write-Host ""
Write-Host "=== HOW TO READ THIS ===" -ForegroundColor Cyan
Write-Host "  control PASS + task PASS  => ConPTY works headless in session 0. GREEN for cutover." -ForegroundColor Gray
Write-Host "  control PASS + task FAIL  => session 0 IS the blocker (the real finding). Stop + report." -ForegroundColor Gray
Write-Host "  control FAIL              => harness/claude flags broken; task result is meaningless." -ForegroundColor Gray
Write-Host "  task log SessionId not 0  => task did NOT run in session 0; a PASS would not transfer." -ForegroundColor Gray
Write-Host ""
Write-Host "=== DONE. Paste BOTH log blocks above back to the analyst. ===" -ForegroundColor Cyan
Write-Host "Cleanup when finished:" -ForegroundColor DarkGray
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor DarkGray
