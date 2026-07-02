# register-restart-oneshot.ps1
# Arms a ONE-TIME scheduled task that runs the vetted cutover-restart.ps1 detached
# under the Task Scheduler service (a process tree SEPARATE from the daemon), so it
# survives the analyst session being killed when the daemon stops.
#
# Why detached: the analyst claude.exe is a direct child of the daemon node.exe.
# An in-session (or Start-Process child) Stop+Start dies at Stop and never reaches
# Start -> fleet down with no recovery. The scheduler-owned task is not a daemon
# child, so it completes Stop -> Start after our session dies. Daemon returns;
# agents respawn via --continue (history intact).
#
# Self-limiting: one-time trigger; cannot re-fire. Unregistered on session resume.
# Requires: elevated PowerShell (managing scheduled tasks + Highest run level).

$ErrorActionPreference = 'Stop'

$TaskName = 'cortextos-restart-oneshot'
$Payload  = 'C:\Users\lukes\cortextos\scripts\restart-daemon-oneshot-payload.ps1'

if (-not (Test-Path $Payload)) { throw "payload not found: $Payload" }

# Codex#5: assert elevation before touching scheduled tasks (fail early, not mid-arm).
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'must run elevated to register/Highest a scheduled task'
}

# Codex#4: refuse re-arm if a prior one-shot is currently RUNNING (avoid overlap).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw "$TaskName is currently Running; refusing to re-arm (would overlap)"
}
# Remove any stale (non-running) instance first (idempotent re-arm).
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$Payload`""

# Fire 60s out: enough lead for this script to return and for smith's go to settle.
$startAt = (Get-Date).AddSeconds(60)
$trigger = New-ScheduledTaskTrigger -Once -At $startAt

# S4U (no stored password), Highest run level so it can Stop/Start the daemon task
# whether or not the interactive user is logged on - matches the daemon task principal.
$principal = New-ScheduledTaskPrincipal -UserId 'lukes' -LogonType S4U -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'One-shot detached daemon restart to deploy upstream-9 weave (self-cleaning).' | Out-Null

# Codex#6: confirm it registered Ready with the expected next-run time.
$t = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ("ARMED: $TaskName state=" + $t.State + " nextRun=" + $info.NextRunTime)
Write-Output ("fires(intended)=" + $startAt.ToString('o'))
Write-Output "Payload: $Payload"
Write-Output "Now: $((Get-Date).ToString('o'))"
# Codex p2 #4: fail (not warn) if it did not register Ready - no false confidence.
if ($t.State -ne 'Ready') { throw ("registered but state is " + $t.State + ", expected Ready") }
if (-not $info.NextRunTime) { throw 'registered but NextRunTime is empty - trigger did not take' }
