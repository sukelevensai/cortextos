#!/bin/bash
# scripts/lint-unsafe-kills.sh
#
# MIRRORED COPY. Canonical home + full change history:
#   AIAgency/scripts/lint-unsafe-kills.sh
# Per the #1<->#7 seam rule (wiki/concepts/elevated-helper-contract.md,
# AIAgency repo): this is a non-critical lint, so cortextos carries a
# drift-diffed copy rather than a cross-repo dot-source -- a cross-repo
# dependency here would mean a git hook in THIS repo silently no-ops if
# the AIAgency checkout is absent/renamed/mid-sync at commit time. Keep
# this file byte-identical to the AIAgency original; if you need to
# change the ban list, edit AIAgency's copy first and port the diff here.
#
# Fragility 1 / Layer 3 (repo-layer commit-time LINT, not a runtime control).
# Scans staged (or explicitly given) *.ps1 files for the machine-wide
# process-kill patterns that caused the 2026-07-01/02 crash incidents.
# Full ban-list rationale: AIAgency wiki/concepts/elevated-helper-contract.md
#
# THIS SCRIPT MUST FAIL OPEN ON ITS OWN ERRORS.
#   A broken lint must never wedge the operator's ability to commit.
#   Only a CONFIRMED pattern match may block a commit.
#
# Exit codes (this script's own contract with its callers):
#   0 = clean (no confirmed match) OR the lint could not run (missing
#       python3, unreadable file, internal error) -- always fail OPEN.
#   1 = CONFIRMED match against one of the 8 ban patterns below.
#   Callers (pre-commit hooks) MUST treat any exit code other than
#   exactly 1 as "pass" -- never block on exit 2/126/127/etc, those are
#   this script failing, not a confirmed unsafe pattern.
#
# Usage:
#   scripts/lint-unsafe-kills.sh
#     No args: auto-detect staged *.ps1 files via `git diff --cached`
#     and scan the STAGED content (git show ":<path>"), not the working
#     tree, so the scan matches exactly what is about to be committed.
#     This is the mode the pre-commit hooks use.
#
#   scripts/lint-unsafe-kills.sh <file1> [<file2> ...]
#     Direct mode: scan the given files on disk as-is, regardless of
#     extension or git staging state. Used for validation/testing
#     against the quarantined fixture scripts (whose extension is
#     *.ps1.QUARANTINED-... not *.ps1) and against known-safe fixtures.
#
# Ban list (see AIAgency wiki/concepts/elevated-helper-contract.md section 2
# for full rationale on each):
#   1. Get-Process by image name piped to a kill verb (machine-wide)
#   2. taskkill ... /T not scoped to a bound own-root PID var (exempt-qualified)
#   3. taskkill ... /IM (image-name kill, no exemption possible)
#   4. schtasks ... /RU SYSTEM (SYSTEM-elevated scheduled task)
#   5. Stop-Process -Name (image-name kill)
#   6. Get-CimInstance Win32_Process (unfiltered) -> narrowed only by
#      .Name/.ProcessName -> killed (multiline/proximity, NOT single-line)
#   7. Start-Process -Verb RunAs (self-elevation)
#   8. /RL HIGHEST on a scheduled task
#
# Why python3 for pattern 6, not grep -E with a negative lookahead:
#   Empirically confirmed (2026-07-02 session) that grep -E does not
#   support lookahead at all -- a "negative lookahead" pattern under
#   -E silently compiles to something that never matches, producing a
#   lint that LOOKS like it works but never fires. Patterns 1-5,7,8 are
#   single-line and use grep -P (PCRE, which DOES support the syntax
#   used below, though none of these particular patterns need
#   lookahead -- they use plain alternation). Pattern 6 requires a real
#   cross-line proximity scan (CIM read on one line, kill verb tens or
#   hundreds of lines later, in a different function), which no single
#   grep line -E or -P can express -- hence python3 for that one.

set -u

FAIL_OPEN() {
  echo "[lint-unsafe-kills] WARNING: $1 -- failing OPEN (not blocking)." >&2
  exit 0
}

# ---------------------------------------------------------------------------
# Step 1: figure out which files to scan, and how to read their content.
# We build a "manifest" of DISPLAY_PATH<US>READ_PATH pairs (US = ASCII unit
# separator 0x1F) so paths containing ':' (Windows drive letters) never
# collide with a delimiter, and so staged-mode can point READ_PATH at a
# temp file holding the STAGED blob while DISPLAY_PATH stays the real path.
# ---------------------------------------------------------------------------

US=$'\x1f'
TMPDIR=""
MANIFEST=""

cleanup() {
  [ -n "$TMPDIR" ] && [ -d "$TMPDIR" ] && rm -rf "$TMPDIR" 2>/dev/null
}
trap cleanup EXIT

# On Git Bash / MSYS (Windows), bash's mktemp/git/redirection all operate on
# a POSIX-style path (e.g. /tmp/tmp.XXXX) that is silently auto-translated
# to a real Windows path ONLY when passed as a standalone argv token to a
# native (non-MSYS) executable -- NOT when that path string is embedded
# inside a file's CONTENT. Our manifest is a file whose content is later
# read by native python3's own open() calls, so every path WRITTEN INTO
# the manifest must already be a real, python-openable path or those reads
# fail with FileNotFoundError even though the file genuinely exists.
# Empirically confirmed this session: `python3 - "$TD/x.txt"` (argv) auto-
# converts and works; a path baked into a heredoc/file does not.
# On real POSIX systems (no cygpath), bash and python share one filesystem
# and no conversion is needed or attempted.
to_native_path() {
  case "$1" in
    /*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
      else
        printf '%s' "$1"
      fi
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

TMPDIR=$(mktemp -d 2>/dev/null) || FAIL_OPEN "could not create temp dir"
MANIFEST="$TMPDIR/manifest.txt"
: > "$MANIFEST" || FAIL_OPEN "could not create manifest file"

if [ "$#" -gt 0 ]; then
  # Direct mode: scan exactly the files given, read straight from disk.
  for f in "$@"; do
    if [ ! -f "$f" ]; then
      echo "[lint-unsafe-kills] WARNING: '$f' not found on disk, skipping." >&2
      continue
    fi
    printf '%s%s%s\n' "$f" "$US" "$(to_native_path "$f")" >> "$MANIFEST"
  done
else
  # Hook mode: auto-detect staged *.ps1 files, scan STAGED content.
  if ! command -v git >/dev/null 2>&1; then
    FAIL_OPEN "git not found on PATH"
  fi
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    FAIL_OPEN "not inside a git repository"
  fi

  STAGED_PS1=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -iE '\.ps1$' || true)
  if [ -z "$STAGED_PS1" ]; then
    exit 0
  fi

  i=0
  while IFS= read -r sp; do
    [ -z "$sp" ] && continue
    i=$((i + 1))
    tmpf="$TMPDIR/staged_$i.ps1"
    if ! git show ":$sp" > "$tmpf" 2>/dev/null; then
      echo "[lint-unsafe-kills] WARNING: could not read staged content of '$sp', skipping." >&2
      continue
    fi
    printf '%s%s%s\n' "$sp" "$US" "$(to_native_path "$tmpf")" >> "$MANIFEST"
  done <<EOF
$STAGED_PS1
EOF
fi

if [ ! -s "$MANIFEST" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: run the actual pattern scan. python3 required (single-line
# patterns COULD be done in pure grep -P, but pattern 6's cross-line
# proximity scan cannot -- keeping everything in one language keeps this
# maintainable and avoids two ban-lists drifting apart).
# ---------------------------------------------------------------------------

if ! command -v python3 >/dev/null 2>&1; then
  FAIL_OPEN "python3 not found on PATH (required for pattern 6 multiline scan)"
fi

python3 - "$(to_native_path "$MANIFEST")" <<'PYEOF'
import re
import sys

US = "\x1f"

def load_manifest(path):
    pairs = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split(US)
            if len(parts) != 2:
                continue
            pairs.append((parts[0], parts[1]))
    return pairs

# --- single-line patterns -------------------------------------------------
P1 = re.compile(r"Get-Process\s+(-Name\s+)?['\"]?(node|claude|codex|chatgpt)[^\n]*\|\s*(Stop-Process|kill)", re.I)
P2_POS = re.compile(r"taskkill(\.exe)?\s+[^\n]*\/T\b", re.I)
P2_EXEMPT = re.compile(r"\$RootPid|\$PID|-RootPid|Get-OwnProcessTree", re.I)
P3 = re.compile(r"taskkill(\.exe)?\s+[^\n]*\/IM\b", re.I)
P4 = re.compile(r"schtasks(\.exe)?\s+[^\n]*\/RU\s+SYSTEM", re.I)
P5 = re.compile(r"Stop-Process\s+[^\n]*-Name\b", re.I)
P7 = re.compile(r"Start-Process\s+[^\n]*-Verb\s+RunAs", re.I)
P8 = re.compile(r"\/RL\s+HIGHEST", re.I)

# --- comment stripping ------------------------------------------------
# PowerShell doc-comments and usage examples routinely include the exact
# strings this lint hunts for (e.g. a library's own header explaining
# "the caller still has to run taskkill /PID $target /T /F" -- real
# example seen in AIAgency's scripts/lib/process-tree-guard.ps1:79, a SAFE
# library whose whole purpose is preventing this class of bug). Scanning
# raw text would false-positive-block exactly the safety code this lint
# exists to protect. Blank out comment lines/spans (preserving line
# COUNT and non-comment line CONTENT) before pattern matching. This is
# a line-oriented heuristic, not a real PowerShell tokenizer: a '#'
# occurring inside a quoted string on an otherwise-code line is not
# specially handled, and a same-line `<# ... #>` block comment blanks
# the WHOLE line rather than surgically removing just the comment span.
# Both are deliberate simplifications for a defense-in-depth lint --
# they trade a small amount of scan coverage for not needing a full
# parser, and neither affects any of the fixtures validated alongside
# this script.
BLOCK_START = re.compile(r"<#")
BLOCK_END = re.compile(r"#>")


def strip_comments(lines):
    out = []
    in_block = False
    for line in lines:
        if in_block:
            if BLOCK_END.search(line):
                in_block = False
            out.append("")
            continue
        m_start = BLOCK_START.search(line)
        if m_start:
            after_start = line[m_start.end():]
            if BLOCK_END.search(after_start):
                # single-line <# ... #> block comment -- blank the whole
                # line rather than surgically extracting any code that
                # might follow #> on the same line (rare in practice).
                out.append("")
            else:
                in_block = True
                out.append(line[:m_start.start()])
            continue
        stripped = line.lstrip()
        if stripped.startswith("#"):
            out.append("")
            continue
        out.append(line)
    return out


# --- pattern 6: multiline / proximity -------------------------------------
# Get-CimInstance Win32_Process with no -Filter on ProcessId/ParentProcessId
# on the same line, followed later in the file by a kill verb, where a
# .Name / .ProcessName narrowing reference appears somewhere in between.
#
# Deliberately NOT capped at a strict ~30-line window: the two real target
# scripts (leadops-clean-claude-mcp-fanout.ps1, leadops-process-watchdog.ps1)
# split enumeration, classification, and killing across separate named
# functions 100+ lines apart. This is a commit-time LINT (defense-in-depth,
# not a runtime control -- see AIAgency wiki/concepts/elevated-helper-contract.md),
# so scanning "rest of file after the anchor" trades a small amount of
# false-positive risk in future large files for actually catching the
# incident-class scripts this lint exists to catch. As of 2026-07, the
# ONLY files in AIAgency's scripts/ that reference Win32_Process at all are
# the two quarantined fixtures this pattern targets -- see the validation
# matrix run alongside this script for the current false-positive check.
ANCHOR = re.compile(r"Get-CimInstance\s+Win32_Process", re.I)
FILTER_SCOPE = re.compile(r"-Filter\s*[^\n]*\b(ProcessId|ParentProcessId)\b", re.I)
KILL_VERB = re.compile(r"Stop-Process|taskkill", re.I)
NARROW = re.compile(r"\.Name\b|\.ProcessName\b", re.I)


def scan_single_line_patterns(lines):
    findings = []
    for i, line in enumerate(lines, start=1):
        if P1.search(line):
            findings.append((1, i, "Get-Process by image name piped to a kill verb (machine-wide)", line))
        m2 = P2_POS.search(line)
        if m2 and not P2_EXEMPT.search(line):
            findings.append((2, i, "taskkill /T not scoped to a bound own-root PID var", line))
        if P3.search(line):
            findings.append((3, i, "taskkill /IM (image-name kill, no exemption)", line))
        if P4.search(line):
            findings.append((4, i, "schtasks creating a SYSTEM-elevated task", line))
        if P5.search(line):
            findings.append((5, i, "Stop-Process -Name (image-name kill)", line))
        if P7.search(line):
            findings.append((7, i, "Start-Process -Verb RunAs (self-elevation)", line))
        if P8.search(line):
            findings.append((8, i, "/RL HIGHEST on a scheduled task", line))
    return findings


def scan_pattern6(lines):
    findings = []
    n = len(lines)
    anchors = []
    for i, line in enumerate(lines, start=1):
        if ANCHOR.search(line) and not FILTER_SCOPE.search(line):
            anchors.append(i)

    for anchor_line in anchors:
        # 0-indexed slice: lines[anchor_line:] are everything AFTER the
        # anchor line (anchor_line is already 1-indexed, so this slice
        # starts at the next line).
        for j in range(anchor_line, n):
            line = lines[j]
            if KILL_VERB.search(line):
                kill_line_no = j + 1
                window = lines[anchor_line:kill_line_no]  # anchor+1 .. kill line, inclusive
                window_text = "\n".join(window)
                if NARROW.search(window_text):
                    findings.append((
                        6, kill_line_no,
                        f"Get-CimInstance Win32_Process (unfiltered, line {anchor_line}) "
                        f"narrowed only by .Name/.ProcessName then killed",
                        line,
                    ))
                    break  # one finding per anchor is enough
    return findings


def main():
    if len(sys.argv) != 2:
        print("[lint-unsafe-kills] internal error: expected exactly one manifest arg", file=sys.stderr)
        sys.exit(0)  # fail open

    manifest_path = sys.argv[1]
    try:
        pairs = load_manifest(manifest_path)
    except Exception as exc:
        print(f"[lint-unsafe-kills] WARNING: could not read manifest ({exc}) -- failing OPEN.", file=sys.stderr)
        sys.exit(0)

    any_confirmed = False

    for display_path, read_path in pairs:
        try:
            with open(read_path, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read()
        except Exception as exc:
            print(f"[lint-unsafe-kills] WARNING: could not read '{display_path}' ({exc}) -- skipping (fail open).", file=sys.stderr)
            continue

        lines = content.splitlines()

        try:
            scan_lines = strip_comments(lines)
            findings = scan_single_line_patterns(scan_lines) + scan_pattern6(scan_lines)
        except Exception as exc:
            print(f"[lint-unsafe-kills] WARNING: scan crashed on '{display_path}' ({exc}) -- skipping (fail open).", file=sys.stderr)
            continue

        if findings:
            any_confirmed = True
            print(f"[lint-unsafe-kills] BLOCKED: unsafe process-kill pattern(s) in {display_path}")
            for pattern_no, line_no, desc, snippet in sorted(findings, key=lambda f: (f[1], f[0])):
                snippet_display = snippet.strip()
                if len(snippet_display) > 160:
                    snippet_display = snippet_display[:160] + "...[truncated]"
                print(f"    line {line_no}: pattern {pattern_no} -- {desc}")
                print(f"      {snippet_display}")

    if any_confirmed:
        print("")
        print("See AIAgency wiki/concepts/elevated-helper-contract.md section 2 for the full ban list and rationale.")
        sys.exit(1)

    sys.exit(0)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # noqa: BLE001 -- deliberate catch-all, this lint must fail open
    print(f"[lint-unsafe-kills] WARNING: unexpected top-level error ({exc}) -- failing OPEN.", file=sys.stderr)
    sys.exit(0)
PYEOF

PY_EXIT=$?
exit "$PY_EXIT"
