$ErrorActionPreference = 'Stop'

function Write-Step($message) {
  Write-Host ""
  Write-Host "== $message ==" -ForegroundColor Cyan
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  throw "Run this from an Administrator PowerShell window."
}

$taskName = 'cortextos-daemon-session0'
$frameworkRoot = 'C:\Users\lukes\cortextos'
$ctxRoot = 'C:\Users\lukes\.cortextos\default'
$pidFile = Join-Path $ctxRoot 'daemon.pid'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Step "Stopping scheduled task"
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Step "Stopping current daemon process tree"
$daemonPids = @()
if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pidText -match '^\d+$') {
    $daemonPids += [int]$pidText
  }
}
$daemonPids += Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist\\daemon\.js|cortextos.*daemon' } |
  Select-Object -ExpandProperty ProcessId
$daemonPids = $daemonPids | Sort-Object -Unique

$all = Get-CimInstance Win32_Process
$childrenByParent = @{}
foreach ($proc in $all) {
  if (-not $childrenByParent.ContainsKey($proc.ParentProcessId)) {
    $childrenByParent[$proc.ParentProcessId] = @()
  }
  $childrenByParent[$proc.ParentProcessId] += $proc.ProcessId
}

$tree = New-Object System.Collections.Generic.List[int]
function Add-ChildTree([int]$processIdToAdd) {
  if ($tree.Contains($processIdToAdd)) { return }
  $tree.Add($processIdToAdd)
  if ($childrenByParent.ContainsKey($processIdToAdd)) {
    foreach ($childId in $childrenByParent[$processIdToAdd]) {
      Add-ChildTree ([int]$childId)
    }
  }
}

foreach ($daemonPid in $daemonPids) {
  if (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue) {
    Add-ChildTree $daemonPid
  }
}

if ($tree.Count -eq 0) {
  Write-Host "No daemon process tree found."
} else {
  $tree.ToArray() | Sort-Object -Descending | ForEach-Object {
    try {
      Stop-Process -Id $_ -Force -ErrorAction Stop
      Write-Host "stopped process $_"
    } catch {
      Write-Warning "could not stop process $_ : $($_.Exception.Message)"
    }
  }
}

Start-Sleep -Seconds 3

Write-Step "Switching scheduled task to S4U hidden Session 0 token"
$action = New-ScheduledTaskAction `
  -Execute (Join-Path $frameworkRoot 'scripts\daemon-svc-launch.cmd') `
  -WorkingDirectory $frameworkRoot
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType S4U `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
Set-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null

Write-Step "Removing stale daemon pid file"
if (Test-Path -LiteralPath $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host "removed $pidFile"
}

Write-Step "Starting scheduled daemon"
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 15

Write-Step "Task principal and state"
Get-ScheduledTask -TaskName $taskName | Select-Object -ExpandProperty Principal | Format-List *
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State | Format-Table -AutoSize
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime,LastTaskResult,NumberOfMissedRuns | Format-List

Write-Step "IPC pipe check"
node -e "const net=require('net'); const pipe='\\\\.\\pipe\\cortextos-default'; const s=net.createConnection(pipe); s.on('connect',()=>{console.log('CONNECTED'); s.end();}); s.on('error',e=>{console.log('ERR', e.code, e.message); process.exitCode=1;}); setTimeout(()=>process.exit(process.exitCode||0),3000);"

Write-Step "cortextos status"
cortextos status
