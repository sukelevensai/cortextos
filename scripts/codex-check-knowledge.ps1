#!/usr/bin/env pwsh
# codex-check-knowledge.ps1
# Internal-consistency check of orgs/sitesmith-agency/knowledge.md via Codex CLI.
# Prepared 2026-05-14 for the cortextOS onboarding flow.
#
# Output: writes structured findings to scripts/codex-knowledge-findings.md
# Run from the cortextos repo root or anywhere; uses $PSScriptRoot.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$KnowledgePath = Join-Path $RepoRoot 'orgs\sitesmith-agency\knowledge.md'
$FindingsPath = Join-Path $RepoRoot 'scripts\codex-knowledge-findings.md'
$PromptPath = Join-Path $env:TEMP 'codex-knowledge-prompt.txt'

if (-not (Test-Path $KnowledgePath)) {
    Write-Error "knowledge.md not found at $KnowledgePath"
    exit 1
}

$KnowledgeContent = Get-Content $KnowledgePath -Raw

$Prompt = @"
You are reviewing a knowledge.md file that will be loaded into every autonomous AI agent's context on every session boot. The file defines an AI agency's shared context: business model, team, tech stack, agents being built, operating rules, mental models, and live state.

Your ONLY job here is INTERNAL CONSISTENCY. Find:

1. CONTRADICTIONS between sections (e.g. section 3 says one thing, section 11 contradicts it)
2. NUMERIC DRIFT (e.g. one section says delivery is 3 days, another says 5-7 days)
3. ENTITY-NAME INCONSISTENCIES (people, products, accounts referenced by different names or spellings)
4. DANGLING REFERENCES (mentions of "see section X" where section X doesn't exist or doesn't cover that)
5. SCHEMA INCONSISTENCIES in tables (column counts, value formats, ordering breaks)
6. POLICY CONFLICTS (e.g. one rule says X is always required, another exempts X)
7. STALE REFERENCES (e.g. mentions of tools/people the doc itself later says are retired)

Do NOT:
- Suggest new content
- Critique the writing style
- Fact-check against external sources
- Comment on whether the strategy is good

DO:
- Quote the exact conflicting lines with section numbers
- Rank findings by severity: CRITICAL (would actively mislead an agent), HIGH (creates ambiguity), LOW (cosmetic)
- Be exhaustive: a 25-section doc loaded on every boot is high-leverage; any inconsistency compounds

Output format: markdown findings list, ranked by severity, each finding with:
- Severity tag (CRITICAL / HIGH / LOW)
- Section refs (e.g. "Section 3a vs Section 11c")
- Quoted conflicting text
- One-sentence proposed resolution

If the doc is internally consistent, say so explicitly with one or two example checks you performed.

The full knowledge.md follows:

---

$KnowledgeContent
"@

# Write prompt to temp file so cmd.exe stdin redirection can feed it cleanly.
# PowerShell object pipelines don't reliably feed stdin to native executables.
Set-Content -Path $PromptPath -Value $Prompt -Encoding utf8 -NoNewline

$PromptBytes = (Get-Item $PromptPath).Length
Write-Host "Prompt written: $PromptPath ($PromptBytes bytes)" -ForegroundColor Cyan
Write-Host "Knowledge.md: $($KnowledgeContent.Length) chars, $((Get-Content $KnowledgePath | Measure-Object -Word).Words) words" -ForegroundColor Cyan
Write-Host "Running Codex (non-interactive, stdin via cmd.exe redirect). 1 to 3 min." -ForegroundColor Cyan
Write-Host ""

# Use cmd.exe to redirect stdin from the temp file AND to redirect stdout to the
# findings file inside cmd's own redirection. This sidesteps the PowerShell 5.1
# stderr-wraps-as-NativeCommandError trap (see ~/.claude/CLAUDE.md PowerShell
# section). Stderr stays loose for visibility but does not poison the exit code.
$cmdLine = "codex exec --skip-git-repo-check < `"$PromptPath`" > `"$FindingsPath`""
Write-Host "cmd /c $cmdLine" -ForegroundColor DarkGray

cmd.exe /c $cmdLine

$exitCode = $LASTEXITCODE

# Cleanup temp prompt
try { Remove-Item -Path $PromptPath -Force -ErrorAction SilentlyContinue } catch {}

if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "Codex exit code: $exitCode (may still have produced partial output)" -ForegroundColor Yellow
    Write-Host "Findings file: $FindingsPath" -ForegroundColor Yellow
    exit $exitCode
}

Write-Host ""
Write-Host "Findings written to: $FindingsPath" -ForegroundColor Green
