$ErrorActionPreference = 'SilentlyContinue'
$log = 'C:\Users\lukes\cortextos\scripts\cutover-restart.log'
function Log($m) { "$([DateTime]::UtcNow.ToString('o')) $m" | Out-File -FilePath $log -Append -Encoding ascii }
Log 'RESTART-START pull-first cutover (security batch + GAP-0068 + upstream merge)'
Start-Sleep -Seconds 6
$before = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*daemon.js*' }
Stop-ScheduledTask -TaskName cortextos-daemon-session0
Log 'daemon task stopped'
Start-Sleep -Seconds 5
foreach ($p in $before) { try { Stop-Process -Id $p.ProcessId -Force; Log ("killed lingering daemon pid " + $p.ProcessId) } catch {} }
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName cortextos-daemon-session0
Log 'daemon task started'
Start-Sleep -Seconds 16
$t = Get-ScheduledTask -TaskName cortextos-daemon-session0
Log ('final daemon task state=' + $t.State)
Log 'RESTART-DONE'
