@echo off
setlocal

cd /d C:\Users\lukes\cortextos\dashboard

set NODE_ENV=development
set CTX_INSTANCE_ID=default
set CTX_FRAMEWORK_ROOT=C:\Users\lukes\cortextos
set CTX_PROJECT_ROOT=C:\Users\lukes\cortextos
set CTX_ROOT=C:\Users\lukes\.cortextos\default

"C:\Program Files\nodejs\npm.cmd" run dev >> C:\Users\lukes\cortextos\scripts\dashboard-session0.log 2>&1
