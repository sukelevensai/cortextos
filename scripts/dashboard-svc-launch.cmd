@echo off
REM cortextOS dashboard launcher for the session-0 scheduled task (replaces PM2).
REM Replicates the env from ecosystem.config.js (PORT only; next loads
REM dashboard/.env.local itself), then runs the Next.js dev server.
REM ASCII-only, no BOM (batch is BOM-sensitive).
set "PORT=3000"
cd /d "C:\Users\lukes\cortextos\dashboard"
"C:\nvm4w\nodejs\node.exe" "C:\Users\lukes\cortextos\dashboard\node_modules\next\dist\bin\next" dev
