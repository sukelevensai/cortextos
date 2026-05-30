# start-cf-tunnel.ps1
# Starts a Cloudflare quick-tunnel exposing dashboard at localhost:3000.
# Random *.trycloudflare.com URL (no domain required, no auth on CF side).
# Dashboard's own login (ADMIN_USERNAME/ADMIN_PASSWORD) is the only auth layer.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-cf-tunnel.ps1

$ErrorActionPreference = 'Stop'

# Refresh PATH in case cloudflared was just installed
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Error "cloudflared not found on PATH. Install: winget install Cloudflare.cloudflared"
    exit 1
}

$logFile = "$env:USERPROFILE\.cortextos\default\logs\cloudflared-tunnel.log"
$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# Kill any prior tunnel processes (idempotent restart)
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Start tunnel in background, write all output to log file
$tunnelArgs = @('tunnel', '--no-autoupdate', '--url', 'http://localhost:3000')
$proc = Start-Process -FilePath $cloudflared.Source `
    -ArgumentList $tunnelArgs `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err"

Write-Host "cloudflared started (pid: $($proc.Id)). Waiting for URL..."

# Poll log for trycloudflare URL (appears within ~5-10s)
$url = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path "$logFile.err") {
        $content = Get-Content "$logFile.err" -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $url = $matches[0]
            break
        }
    }
    if (Test-Path $logFile) {
        $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $url = $matches[0]
            break
        }
    }
}

if ($url) {
    Write-Host ""
    Write-Host "==============================================="
    Write-Host "TUNNEL URL: $url"
    Write-Host "==============================================="
    Write-Host ""
    Write-Host "Open on Mac: $url"
    Write-Host "Login with dashboard credentials (sitesmith / your password)"
    Write-Host ""
    Write-Host "Tunnel PID: $($proc.Id)"
    Write-Host "Log: $logFile"
    Write-Host "Stop: Stop-Process -Id $($proc.Id) -Force"
} else {
    Write-Error "Tunnel started (pid: $($proc.Id)) but URL not detected in 60s. Check log: $logFile.err"
    exit 1
}
