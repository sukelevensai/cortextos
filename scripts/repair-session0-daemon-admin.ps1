param(
  [int]$OrphanDaemonPid = 0
)

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
$ctxRoot = 'C:\Users\lukes\.cortextos\default'
$pidFile = Join-Path $ctxRoot 'daemon.pid'
$frameworkRoot = 'C:\Users\lukes\cortextos'
$daemonLog = Join-Path $frameworkRoot 'scripts\daemon-session0.log'

if ($OrphanDaemonPid -eq 0 -and (Test-Path -LiteralPath $daemonLog)) {
  $lines = Get-Content -LiteralPath $daemonLog -Tail 500 -ErrorAction SilentlyContinue
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match '\[daemon\] Running \(pid: (\d+)\)') {
      $OrphanDaemonPid = [int]$Matches[1]
      break
    }
  }
}

Write-Step "Stopping scheduled task if active"
try {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} catch {
  Write-Warning "Stop-ScheduledTask warning: $($_.Exception.Message)"
}

Write-Step "Stopping orphan daemon tree rooted at PID $OrphanDaemonPid"
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

if ($OrphanDaemonPid -gt 0 -and (Get-Process -Id $OrphanDaemonPid -ErrorAction SilentlyContinue)) {
  Add-ChildTree $OrphanDaemonPid
  $tree.ToArray() | Sort-Object -Descending | ForEach-Object {
    try {
      Stop-Process -Id $_ -Force -ErrorAction Stop
      Write-Host "stopped process $_"
    } catch {
      Write-Warning "could not stop process $_ : $($_.Exception.Message)"
    }
  }
} else {
  Write-Host "no orphan daemon PID found or PID is not running"
}

Write-Step "Stopping hidden Bash workers left by previous shell snapshots"
Get-CimInstance Win32_Process -Filter "Name='bash.exe'" |
  Where-Object { $_.SessionId -eq 0 -or ($_.CommandLine -and $_.CommandLine -match 'shell-snapshots|snapshot-bash') } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Host "stopped bash process $($_.ProcessId)"
    } catch {
      Write-Warning "could not stop bash process $($_.ProcessId) : $($_.Exception.Message)"
    }
  }

Start-Sleep -Seconds 3

Write-Step "Removing stale daemon pid file"
if (Test-Path -LiteralPath $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host "removed $pidFile"
} else {
  Write-Host "no daemon pid file found"
}

Write-Step "Starting scheduled daemon"
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 15

Write-Step "Scheduled task state"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State | Format-Table -AutoSize
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime,LastTaskResult,NumberOfMissedRuns | Format-List

Write-Step "Daemon node processes"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'cortextos|daemon|dist\\daemon\.js' } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine |
  Format-List

Write-Step "IPC pipe check"
node -e "const net=require('net'); const pipe='\\\\.\\pipe\\cortextos-default'; const s=net.createConnection(pipe); s.on('connect',()=>{console.log('CONNECTED'); s.end();}); s.on('error',e=>{console.log('ERR', e.code, e.message); process.exitCode=1;}); setTimeout(()=>process.exit(process.exitCode||0),3000);"

Write-Step "cortextos status"
cortextos status
