@echo off
setlocal

cd /d C:\Users\lukes\cortextos

set NODE_ENV=production
set CORTEXTOS_INSTANCE=default
set CTX_INSTANCE_ID=default
set CTX_FRAMEWORK_ROOT=C:\Users\lukes\cortextos
set CTX_PROJECT_ROOT=C:\Users\lukes\cortextos
set CTX_ROOT=C:\Users\lukes\.cortextos\default
set CLAUDE_CODE_USE_POWERSHELL_TOOL=1
set CLAUDE_CODE_SHELL=powershell.exe
set CLAUDE_BASH_NO_LOGIN=true
set SHELL=powershell.exe
set PATH=C:\Users\lukes\.local\bin;C:\Users\lukes\cortextos\bin;C:\Users\lukes\AppData\Roaming\npm;C:\nvm4w\nodejs;%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%

C:\nvm4w\nodejs\node.exe C:\Users\lukes\cortextos\dist\daemon.js --instance default >> C:\Users\lukes\cortextos\scripts\daemon-session0.log 2>&1
