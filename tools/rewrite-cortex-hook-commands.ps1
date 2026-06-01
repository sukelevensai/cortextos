$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$hookPrefix = 'CORTEXTOS_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"; CORTEXTOS_ROOT="$(cygpath -u "$CORTEXTOS_ROOT" 2>/dev/null || printf ''%s'' "$CORTEXTOS_ROOT")"; "$CORTEXTOS_ROOT/bin/cortextos-hook.sh"'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$roots = @(
  (Join-Path $repoRoot 'orgs'),
  (Join-Path $repoRoot 'templates'),
  (Join-Path $repoRoot 'community')
) | Where-Object { Test-Path -LiteralPath $_ }

$files = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Filter settings.json -Force |
    Where-Object {
      $raw = Get-Content -Raw -LiteralPath $_.FullName
      $raw -match '"command"\s*:\s*"cortextos '
    }
}

function Update-Commands {
  param([object]$Node)

  if ($null -eq $Node) { return }

  if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
    foreach ($item in $Node) { Update-Commands -Node $item }
    return
  }

  foreach ($prop in @($Node.PSObject.Properties)) {
    if ($prop.Name -eq 'command' -and $prop.Value -is [string] -and $prop.Value.StartsWith('cortextos ')) {
      $prop.Value = $hookPrefix + $prop.Value.Substring('cortextos'.Length)
      continue
    }
    Update-Commands -Node $prop.Value
  }
}

$updated = @()
foreach ($file in $files) {
  $raw = Get-Content -Raw -LiteralPath $file.FullName
  $json = $raw | ConvertFrom-Json
  Update-Commands -Node $json

  Copy-Item -LiteralPath $file.FullName -Destination "$($file.FullName).bak-$stamp"
  $json | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $file.FullName -Encoding UTF8
  $updated += $file.FullName
}

[pscustomobject]@{
  UpdatedCount = $updated.Count
  UpdatedFiles = $updated
} | ConvertTo-Json -Depth 5
