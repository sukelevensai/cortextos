$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$userHome = $env:USERPROFILE
$bashCandidates = @(
  'C:\Program Files\Git\bin\bash.exe',
  'C:\Program Files\Git\usr\bin\bash.exe'
)
$bash = $bashCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $bash) {
  throw 'Git Bash not found'
}

function Get-ConsoleProcessCounts {
  Get-Process -Name bash,cat,cmd,conhost,powershell,OpenConsole,WindowsTerminal -ErrorAction SilentlyContinue |
    Group-Object ProcessName |
    Sort-Object Count -Descending |
    Select-Object Count,Name
}

function Invoke-BashSyntax {
  param([string]$Path)
  & $bash -n $Path 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "bash syntax failed: $Path"
  }
}

function Invoke-BashCommandSyntax {
  param([string]$Command)
  $temp = Join-Path $env:TEMP ("cortex-hook-command-{0}.sh" -f ([guid]::NewGuid().ToString('N')))
  try {
    Set-Content -LiteralPath $temp -Value "#!/usr/bin/env bash`n$Command`n" -Encoding UTF8
    & $bash -n $temp 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "bash command syntax failed: $Command"
    }
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-HookSmoke {
  param(
    [string]$Path,
    [string]$Payload
  )
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $Payload | & $bash $Path *> $null
  $code = $LASTEXITCODE
  $sw.Stop()
  [pscustomobject]@{
    Path = $Path
    ExitCode = $code
    Milliseconds = [math]::Round($sw.Elapsed.TotalMilliseconds)
  }
}

function Get-CommandStringsFromJson {
  param($Json)
  $commands = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($Json)
  while ($stack.Count -gt 0) {
    $node = $stack.Pop()
    if ($null -eq $node) { continue }
    if ($node -is [System.Collections.IEnumerable] -and $node -isnot [string]) {
      foreach ($item in $node) { $stack.Push($item) }
      continue
    }
    foreach ($prop in @($node.PSObject.Properties)) {
      if ($prop.Name -eq 'command' -and $prop.Value -is [string]) {
        $commands += $prop.Value
      } else {
        $stack.Push($prop.Value)
      }
    }
  }
  return $commands
}

function Test-CodexHookCommand {
  param([string]$Command)
  if ($Command -match "^(?<bash>[A-Za-z]:\\[^']*bash\.exe)\s+'(?<script>[^']+)'(?<args>.*)$") {
    $bashPath = $Matches.bash
    $scriptPath = $Matches.script
    if (-not (Test-Path -LiteralPath $bashPath)) {
      throw "Codex hook bash executable not found: $bashPath"
    }
    if (-not (Test-Path -LiteralPath $scriptPath)) {
      throw "Codex hook script not found: $scriptPath"
    }
    Invoke-BashSyntax -Path $scriptPath
    return
  }

  Invoke-BashCommandSyntax -Command $Command
}

$before = Get-ConsoleProcessCounts

$shellHookRoots = @(
  (Join-Path $userHome '.claude\hooks'),
  (Join-Path $userHome '.codex\hooks')
) | Where-Object { Test-Path -LiteralPath $_ }

$shellHooks = foreach ($root in $shellHookRoots) {
  Get-ChildItem -LiteralPath $root -Filter '*.sh' -Force
}

$syntaxChecked = @()
foreach ($hook in $shellHooks) {
  Invoke-BashSyntax -Path $hook.FullName
  $syntaxChecked += $hook.FullName
}

$commandFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'orgs') -Recurse -Filter settings.json -Force
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'templates') -Recurse -Filter settings.json -Force
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'community') -Recurse -Filter settings.json -Force
) | Where-Object { $_ }

$commandChecked = @()
$plainCortextos = @()
foreach ($file in $commandFiles) {
  $json = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
  $commands = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($json)
  while ($stack.Count -gt 0) {
    $node = $stack.Pop()
    if ($null -eq $node) { continue }
    if ($node -is [System.Collections.IEnumerable] -and $node -isnot [string]) {
      foreach ($item in $node) { $stack.Push($item) }
      continue
    }
    foreach ($prop in @($node.PSObject.Properties)) {
      if ($prop.Name -eq 'command' -and $prop.Value -is [string]) {
        $commands += $prop.Value
      } else {
        $stack.Push($prop.Value)
      }
    }
  }

  foreach ($command in $commands) {
    if ($command -match '^cortextos\s') {
      $plainCortextos += [pscustomobject]@{ Path = $file.FullName; Command = $command }
    }
    Invoke-BashCommandSyntax -Command $command
    $commandChecked += [pscustomobject]@{ Path = $file.FullName; Command = $command }
  }
}

$globalClaudeSettings = Join-Path $userHome '.claude\settings.json'
$globalClaudeCommands = @()
if (Test-Path -LiteralPath $globalClaudeSettings) {
  $globalJson = Get-Content -Raw -LiteralPath $globalClaudeSettings | ConvertFrom-Json
  foreach ($command in (Get-CommandStringsFromJson -Json $globalJson.hooks)) {
    Invoke-BashCommandSyntax -Command $command
    $globalClaudeCommands += $command
  }
}

$globalCodexHooks = Join-Path $userHome '.codex\hooks.json'
$globalCodexCommands = @()
if (Test-Path -LiteralPath $globalCodexHooks) {
  $globalCodexJson = Get-Content -Raw -LiteralPath $globalCodexHooks | ConvertFrom-Json
  foreach ($command in (Get-CommandStringsFromJson -Json $globalCodexJson.hooks)) {
    Test-CodexHookCommand -Command $command
    $globalCodexCommands += $command
  }
}

$sourceRoots = @(
  (Join-Path $repoRoot 'src'),
  (Join-Path $repoRoot 'bus')
) | Where-Object { Test-Path -LiteralPath $_ }
$sourceFiles = foreach ($root in $sourceRoots) {
  Get-ChildItem -LiteralPath $root -Recurse -File -Include '*.ts','*.js','*.sh' -Force |
    Where-Object { $_.FullName -notmatch '\\dist\\|\\node_modules\\' }
}

$sourceBareCortextos = @()
$unboundedCatReads = @()
foreach ($file in $sourceFiles) {
  $matches = Select-String -LiteralPath $file.FullName -Pattern "execFile\(\s*'cortextos'","command:\s*'cortextos","cortextos bus hook-context-status" -ErrorAction SilentlyContinue
  foreach ($match in @($matches)) {
    $sourceBareCortextos += [pscustomobject]@{ Path = $file.FullName; Line = $match.LineNumber; Text = $match.Line.Trim() }
  }

  $catMatches = Select-String -LiteralPath $file.FullName -Pattern 'INPUT=\$\(cat\)' -ErrorAction SilentlyContinue
  foreach ($match in @($catMatches)) {
    $unboundedCatReads += [pscustomobject]@{ Path = $file.FullName; Line = $match.LineNumber; Text = $match.Line.Trim() }
  }
}
if ($sourceBareCortextos.Count -gt 0) {
  throw "source still has bare cortextos hook/exec references: $($sourceBareCortextos | ConvertTo-Json -Compress)"
}
if ($unboundedCatReads.Count -gt 0) {
  throw "source still has unbounded hook cat reads: $($unboundedCatReads | ConvertTo-Json -Compress)"
}

$wrapperVersion = & $bash -lc '/c/Users/lukes/cortextos/bin/cortextos-hook.sh --version'
if ($LASTEXITCODE -ne 0) {
  throw 'cortextos hook wrapper failed'
}

$payload = '{"session_id":"doctor","transcript_path":"C:/nope.jsonl","tool_name":"Write","tool_input":{"file_path":"wiki/doctor.md"}}'
$smokeTargets = @(
  (Join-Path $userHome '.claude\hooks\context-usage-warn.sh'),
  (Join-Path $userHome '.codex\hooks\context-usage-warn.sh'),
  (Join-Path $userHome '.claude\hooks\write-audit-log.sh'),
  (Join-Path $userHome '.codex\hooks\write-audit-log.sh'),
  (Join-Path $userHome '.claude\hooks\codex-crosscheck.sh'),
  (Join-Path $userHome '.codex\hooks\codex-crosscheck.sh'),
  (Join-Path $userHome '.claude\hooks\session-retro.sh'),
  (Join-Path $userHome '.codex\hooks\session-retro.sh')
) | Where-Object { Test-Path -LiteralPath $_ }

$smokeResults = foreach ($target in $smokeTargets) {
  Invoke-HookSmoke -Path $target -Payload $payload
}

$after = Get-ConsoleProcessCounts

[pscustomobject]@{
  Bash = $bash
  WrapperVersion = ($wrapperVersion | Select-Object -First 1)
  ShellHooksSyntaxChecked = $syntaxChecked.Count
  AgentCommandsSyntaxChecked = $commandChecked.Count
  GlobalClaudeCommandsSyntaxChecked = $globalClaudeCommands.Count
  GlobalCodexCommandsSyntaxChecked = $globalCodexCommands.Count
  SourceBareCortextosReferences = $sourceBareCortextos.Count
  UnboundedHookCatReads = $unboundedCatReads.Count
  PlainCortextosCommands = $plainCortextos
  SmokeResults = $smokeResults
  ProcessCountsBefore = $before
  ProcessCountsAfter = $after
} | ConvertTo-Json -Depth 8
