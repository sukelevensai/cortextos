<#
.SYNOPSIS
  Standalone heartbeat watchdog for the cortextOS agent fleet.

.DESCRIPTION
  Runs independently of the cortextOS daemon (its own scheduled task) so it still
  fires an alert even if the daemon or the whole fleet process is dead. Reads the
  enabled-agent list and heartbeat cadence from each agent's config.json, compares
  that cadence against the age of the agent's heartbeat.json, and DMs Luke on
  Telegram when an agent has gone stale.

  Business context: lantern-cfo silently died for about 24 hours and nothing
  alerted the operator until another agent happened to notice. This script closes
  that gap by running as its own scheduled task, outside the daemon's process
  tree, so a dead daemon cannot also silence the alert about itself.

  THRESHOLD MATH (per watched agent):
    expectedMin  = cadence read from config.json crons[name=heartbeat].interval
                   (parsed "4h" / "30m" / "1d"; falls back to -DefaultIntervalMinutes
                   when missing, empty, or unparseable)
    thresholdMin = max(expectedMin * -ThresholdMultiplier, -FloorMinutes)
    breach       = ageMinutes(now - last_heartbeat) > thresholdMin
                   OR heartbeat.json missing OR last_heartbeat unparseable

  Re-alert suppression: once an agent is alerted, it will not be alerted again for
  -ReAlertHours hours, tracked in a small dedup state file. Dry runs never touch
  the dedup state's alert timestamps, so a dry run cannot suppress the first real
  alert.

.NOTES
  EXACT SCHEDULED TASK COMMAND (do not execute here; the operator wires this up):
    powershell -ExecutionPolicy Bypass -NonInteractive -File C:\Users\lukes\cortextos\scripts\heartbeat-watchdog.ps1
#>

[CmdletBinding()]
param(
    [string]$Instance = 'default',
    [int]$ThresholdMultiplier = 3,
    [int]$FloorMinutes = 360,
    [int]$DefaultIntervalMinutes = 240,
    [int]$ReAlertHours = 12,
    [string]$ChatId = $env:CHAT_ID,
    [switch]$DryRun
)

# GAP-0176: chat_id must come from runtime config (env CHAT_ID or -ChatId),
# never a hardcoded operator id in this public-committable script. Fail LOUD
# if unresolved so a misconfigured deploy is caught, not silently un-alerting.
if ([string]::IsNullOrWhiteSpace($ChatId)) {
    throw 'CHAT_ID not set: pass -ChatId or set the CHAT_ID environment variable.'
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ctxRoot = "C:\Users\lukes\.cortextos\$Instance"
$stateDir = Join-Path $ctxRoot 'state'
$logsDir = Join-Path $ctxRoot 'logs'
$logFile = Join-Path $logsDir 'heartbeat-watchdog.log'
$dedupStateFile = Join-Path $stateDir '.heartbeat-watchdog-state.json'
$orgsConfigGlob = 'C:\Users\lukes\cortextos\orgs\*\agents\*\config.json'
$secretsPath = 'C:\Users\lukes\cortextos\orgs\sitesmith-agency\secrets.env'

# ---------------------------------------------------------------------------
# Logging helper. Best-effort: never let a logging failure crash the script.
# ---------------------------------------------------------------------------
function Write-WatchdogLog {
    param([string]$Message)

    try {
        if (-not (Test-Path $logsDir)) {
            New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
        }
        Add-Content -Path $logFile -Value $Message -Encoding UTF8
    } catch {
        Write-Warning "heartbeat-watchdog: failed to write log line: $Message"
    }
}

function Get-UtcIsoNow {
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

# ---------------------------------------------------------------------------
# Step 1: resolve state dir, fatal exit if missing.
# ---------------------------------------------------------------------------
if (-not (Test-Path $stateDir)) {
    Write-WatchdogLog "$(Get-UtcIsoNow) FATAL state dir not found: $stateDir"
    exit 1
}

# ---------------------------------------------------------------------------
# Placeholder guard for secrets (never treat a placeholder string as real).
# ---------------------------------------------------------------------------
function Test-IsPlaceholderToken {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    if ($Value -match '^<.*>$') { return $true }
    if ($Value -match '^\$\{.*\}$') { return $true }
    if ($Value -match '(?i)\b(TODO|CHANGE_?ME|PASTE_?HERE|FILL_?IN|REPLACE|PLACEHOLDER)\b') { return $true }
    return $false
}

# ---------------------------------------------------------------------------
# Interval string parser: "4h" / "30m" / "1d" -> minutes. Falls back to default.
# ---------------------------------------------------------------------------
function Convert-IntervalToMinutes {
    param(
        [string]$IntervalString,
        [int]$Fallback
    )

    if ([string]::IsNullOrWhiteSpace($IntervalString)) { return $Fallback }

    if ($IntervalString -match '^(\d+)h$') {
        return [int]$matches[1] * 60
    }
    if ($IntervalString -match '^(\d+)m$') {
        return [int]$matches[1]
    }
    if ($IntervalString -match '^(\d+)d$') {
        return [int]$matches[1] * 1440
    }

    return $Fallback
}

# ---------------------------------------------------------------------------
# Robust UTC parse of an ISO8601 "...Z" timestamp. Throws on failure.
# ---------------------------------------------------------------------------
function Get-UtcDateTimeSafe {
    param([string]$TimestampString)

    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor `
              [System.Globalization.DateTimeStyles]::AdjustToUniversal
    $dto = [datetimeoffset]::Parse(
        $TimestampString,
        [System.Globalization.CultureInfo]::InvariantCulture,
        $styles
    )
    return $dto.UtcDateTime
}

# ---------------------------------------------------------------------------
# Step 2 + 3: enumerate agent configs, build the watch list with cadence.
# ---------------------------------------------------------------------------
$watchList = New-Object System.Collections.Generic.List[object]

$configFiles = Get-ChildItem -Path $orgsConfigGlob -File -ErrorAction SilentlyContinue

foreach ($configFile in $configFiles) {
    $cfg = $null
    try {
        $raw = Get-Content -Raw -Path $configFile.FullName -ErrorAction Stop
        $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-WatchdogLog "$(Get-UtcIsoNow) WARN unparseable config: $($configFile.FullName)"
        continue
    }

    $isEnabled = $false
    if ($cfg.PSObject.Properties.Name -contains 'enabled') {
        if ($cfg.enabled -eq $true) { $isEnabled = $true }
    }
    if (-not $isEnabled) { continue }

    $agentName = $null
    if ($cfg.PSObject.Properties.Name -contains 'agent_name' -and $cfg.agent_name) {
        $agentName = [string]$cfg.agent_name
    } else {
        $agentName = $configFile.Directory.Name
    }

    $expectedMin = $DefaultIntervalMinutes
    if ($cfg.PSObject.Properties.Name -contains 'crons' -and $cfg.crons) {
        $heartbeatCron = $cfg.crons | Where-Object { $_.name -eq 'heartbeat' } | Select-Object -First 1
        if ($heartbeatCron -and $heartbeatCron.PSObject.Properties.Name -contains 'interval' -and $heartbeatCron.interval) {
            $expectedMin = Convert-IntervalToMinutes -IntervalString ([string]$heartbeatCron.interval) -Fallback $DefaultIntervalMinutes
        }
    }

    $thresholdMin = [math]::Max($expectedMin * $ThresholdMultiplier, $FloorMinutes)

    $watchList.Add([pscustomobject]@{
        AgentName    = $agentName
        ExpectedMin  = $expectedMin
        ThresholdMin = $thresholdMin
    })
}

# ---------------------------------------------------------------------------
# Step 4: check each watched agent's heartbeat for a breach.
# ---------------------------------------------------------------------------
$nowUtc = (Get-Date).ToUniversalTime()
$breaches = New-Object System.Collections.Generic.List[object]

foreach ($watched in $watchList) {
    $hbPath = Join-Path $stateDir (Join-Path $watched.AgentName 'heartbeat.json')

    if (-not (Test-Path $hbPath)) {
        $breaches.Add([pscustomobject]@{
            AgentName = $watched.AgentName
            Reason    = 'no heartbeat file (never started?)'
        })
        continue
    }

    try {
        $hbRaw = Get-Content -Raw -Path $hbPath -ErrorAction Stop
        $hb = $hbRaw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $breaches.Add([pscustomobject]@{
            AgentName = $watched.AgentName
            Reason    = 'unparseable last_heartbeat'
        })
        continue
    }

    $lastHeartbeatUtc = $null
    try {
        $lastHeartbeatUtc = Get-UtcDateTimeSafe -TimestampString ([string]$hb.last_heartbeat)
    } catch {
        $breaches.Add([pscustomobject]@{
            AgentName = $watched.AgentName
            Reason    = 'unparseable last_heartbeat'
        })
        continue
    }

    $ageMinutes = [int][math]::Floor(($nowUtc - $lastHeartbeatUtc).TotalMinutes)

    if ($ageMinutes -gt $watched.ThresholdMin) {
        $reason = "stale $ageMinutes" + "min (expected every $($watched.ExpectedMin)min, threshold $($watched.ThresholdMin)min)"
        $breaches.Add([pscustomobject]@{
            AgentName = $watched.AgentName
            Reason    = $reason
        })
    }
}

# ---------------------------------------------------------------------------
# Step 5: dedup against the state file.
# ---------------------------------------------------------------------------
$stateMap = @{}
try {
    if (Test-Path $dedupStateFile) {
        $stateRaw = Get-Content -Raw -Path $dedupStateFile -ErrorAction Stop
        $parsedState = $stateRaw | ConvertFrom-Json -ErrorAction Stop
        if ($parsedState) {
            foreach ($prop in $parsedState.PSObject.Properties) {
                $stateMap[$prop.Name] = [string]$prop.Value
            }
        }
    }
} catch {
    Write-WatchdogLog "$(Get-UtcIsoNow) WARN failed to read dedup state, starting from empty in-memory map"
    $stateMap = @{}
}

$alertList = New-Object System.Collections.Generic.List[object]
$suppressedList = New-Object System.Collections.Generic.List[object]
$computeSucceeded = $false

try {
    $breachedNames = @{}
    foreach ($breach in $breaches) {
        $breachedNames[$breach.AgentName] = $true

        $alreadyAlertedRecently = $false
        if ($stateMap.ContainsKey($breach.AgentName)) {
            try {
                $lastAlertUtc = Get-UtcDateTimeSafe -TimestampString $stateMap[$breach.AgentName]
                if (($nowUtc - $lastAlertUtc).TotalHours -lt $ReAlertHours) {
                    $alreadyAlertedRecently = $true
                }
            } catch {
                # unparseable stored timestamp: treat as not-recently-alerted
                $alreadyAlertedRecently = $false
            }
        }

        if ($alreadyAlertedRecently) {
            $suppressedList.Add($breach)
        } else {
            $alertList.Add($breach)
            if (-not $DryRun) {
                $stateMap[$breach.AgentName] = Get-UtcIsoNow
            }
        }
    }

    # Remove any agent from the state map that is not currently in breach.
    $keysToRemove = New-Object System.Collections.Generic.List[string]
    foreach ($key in $stateMap.Keys) {
        if (-not $breachedNames.ContainsKey($key)) {
            $keysToRemove.Add($key)
        }
    }
    foreach ($key in $keysToRemove) {
        $stateMap.Remove($key)
    }

    $computeSucceeded = $true
} catch {
    Write-WatchdogLog "$(Get-UtcIsoNow) WARN dedup compute failed, dedup state file will not be updated this run: $($_.Exception.Message)"
}

if ($computeSucceeded) {
    try {
        $stateJson = $stateMap | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($dedupStateFile, $stateJson, (New-Object System.Text.UTF8Encoding $false))
    } catch {
        Write-WatchdogLog "$(Get-UtcIsoNow) WARN failed to write dedup state file: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Step 6: always append the summary log line.
# ---------------------------------------------------------------------------
$checkedCount = $watchList.Count
$breachCount = $breaches.Count
$alertedCount = $alertList.Count
$suppressedCount = $suppressedList.Count

Write-WatchdogLog "$(Get-UtcIsoNow) checked=$checkedCount breaches=$breachCount alerted=$alertedCount suppressed=$suppressedCount"

foreach ($breach in $breaches) {
    $status = 'alerted'
    if ($suppressedList | Where-Object { $_.AgentName -eq $breach.AgentName }) {
        $status = 'suppressed'
    }
    Write-WatchdogLog "    $($breach.AgentName): $($breach.Reason) [$status]"
}

# ---------------------------------------------------------------------------
# Step 7: notify Telegram (or print what would be sent in DryRun mode).
# ---------------------------------------------------------------------------
if ($alertList.Count -gt 0) {
    $bodyLines = New-Object System.Collections.Generic.List[string]
    foreach ($alertItem in $alertList) {
        $bodyLines.Add("- $($alertItem.AgentName): $($alertItem.Reason)")
    }
    $message = "cortextOS watchdog: $($alertList.Count) agent(s) silent past threshold.`n`n" + `
               ($bodyLines -join "`n") + `
               "`n`nCheck the daemon or restart the agent."

    if ($DryRun) {
        Write-Host "DRYRUN target chat_id: $ChatId"
        Write-Host "DRYRUN message:"
        Write-Host $message
        Write-WatchdogLog "$(Get-UtcIsoNow) DRYRUN would alert $($alertList.Count) agents"
    } else {
        $token = $null
        try {
            if (Test-Path $secretsPath) {
                $secretLines = Get-Content -Path $secretsPath
                foreach ($line in $secretLines) {
                    if ($line -match '^CRM_REMINDER_BOT_TOKEN=') {
                        $eqIndex = $line.IndexOf('=')
                        $tokenCandidate = $line.Substring($eqIndex + 1)
                        $tokenCandidate = $tokenCandidate.Trim()
                        $tokenCandidate = $tokenCandidate.Trim('"').Trim("'")
                        $token = $tokenCandidate
                        break
                    }
                }
            }
        } catch {
            Write-WatchdogLog "$(Get-UtcIsoNow) ERROR failed to read secrets file for telegram token: $($_.Exception.Message)"
        }

        if (Test-IsPlaceholderToken -Value $token) {
            Write-WatchdogLog "$(Get-UtcIsoNow) ERROR telegram token missing or placeholder, send aborted"
        } else {
            try {
                $telegramUrl = "https://api.telegram.org/bot$token/sendMessage"
                $telegramBody = @{
                    chat_id = $ChatId
                    text    = $message
                }
                Invoke-RestMethod -Uri $telegramUrl -Method Post -Body $telegramBody | Out-Null
                Write-WatchdogLog "$(Get-UtcIsoNow) telegram sent: $($alertList.Count) agents"
            } catch {
                Write-WatchdogLog "$(Get-UtcIsoNow) ERROR telegram send failed: $($_.Exception.Message)"
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Step 8: normal exit.
# ---------------------------------------------------------------------------
exit 0
