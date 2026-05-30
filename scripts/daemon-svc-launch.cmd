@echo off
REM cortextOS daemon launcher for the session-0 scheduled task (replaces PM2).
REM Replicates the CTX_* env from ecosystem.config.js, then runs the daemon.
REM ASCII-only, no BOM (batch is BOM-sensitive).
set "CTX_INSTANCE_ID=default"
set "CTX_ROOT=C:\Users\lukes\.cortextos\default"
set "CTX_FRAMEWORK_ROOT=C:\Users\lukes\cortextos"
set "CTX_PROJECT_ROOT=C:\Users\lukes\cortextos"
set "CTX_ORG=sitesmith-agency"
cd /d "C:\Users\lukes\cortextos"
"C:\nvm4w\nodejs\node.exe" "C:\Users\lukes\cortextos\dist\daemon.js" --instance default
