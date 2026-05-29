#!/usr/bin/env bash
# kb-daily-ingest.sh
# Daily incremental ingest of AIAgency wiki into the sitesmith-agency KB.
# Stays under Gemini free-tier (~1500 embeddings/day) by ingesting N files per run.
#
# State file format: `<path>|<sha256>` per line.
# On each run, files are re-ingested ONLY if their content hash changed since last ingest.
# This means hot.md (which changes every session) gets re-indexed daily; static rules.md does not.
#
# Run via cortextos cron: `cortextos bus add-cron oracle kb-daily-ingest '0 4 * * *' 'bash $CTX_FRAMEWORK_ROOT/scripts/kb-daily-ingest.sh'`
# Or manually: `bash scripts/kb-daily-ingest.sh`
#
# Tier order (highest leverage first):
#   T1: top-level wiki files (rules, false-beliefs, hot, log, index, pipeline) + AIAgency CLAUDE.md + cortextOS knowledge.md
#   T2: wiki/concepts/*.md (about 100 files)
#   T3: wiki/explorations/*.md
#   T4: wiki/entities/*.md
#   T5: wiki/synthesis/*.md
#   (wiki/sources/*.md deferred indefinitely)

set -euo pipefail

# Defaults (override via env)
ORG="${CTX_ORG:-sitesmith-agency}"
INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
FILES_PER_RUN="${KB_FILES_PER_RUN:-50}"
WIKI_ROOT="${AIAGENCY_WIKI_ROOT:-C:/Users/lukes/Obsidian/AIAgency/AIAgency/wiki}"
AGENCY_ROOT="${AIAGENCY_ROOT:-C:/Users/lukes/Obsidian/AIAgency/AIAgency}"

# Validate FILES_PER_RUN is a positive integer (Codex finding 1)
if ! [[ "$FILES_PER_RUN" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: KB_FILES_PER_RUN must be a positive integer, got: '$FILES_PER_RUN'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR="$HOME/.cortextos/$INSTANCE_ID/orgs/$ORG/knowledge-base"
STATE_FILE="$STATE_DIR/.ingested-paths.txt"
LOG_FILE="$STATE_DIR/daily-ingest.log"

mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

ts() { date -u +%FT%TZ; }
log() { echo "$(ts) $*" | tee -a "$LOG_FILE"; }

# Validate wiki paths
if [[ ! -d "$WIKI_ROOT" ]]; then
  log "ERROR: AIAgency wiki not found at $WIKI_ROOT"
  log "Set AIAGENCY_WIKI_ROOT env var if it lives elsewhere."
  exit 1
fi

# Source Gemini API key from secrets
SECRETS_FILE="$FRAMEWORK_ROOT/orgs/$ORG/secrets.env"
if [[ ! -f "$SECRETS_FILE" ]]; then
  log "ERROR: secrets.env not found at $SECRETS_FILE"
  exit 1
fi
set -o allexport && source "$SECRETS_FILE" && set +o allexport

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  log "ERROR: GEMINI_API_KEY not in $SECRETS_FILE"
  exit 1
fi

# Reject placeholder values (Luke's .env placeholder rule from CLAUDE.md)
case "$GEMINI_API_KEY" in
  '<'*'>'|'${'*'}'|TODO|CHANGE_ME|PASTE_HERE|FILL_IN|REPLACE|PLACEHOLDER|'')
    log "ERROR: GEMINI_API_KEY appears to be a placeholder: $GEMINI_API_KEY"
    log "Edit $SECRETS_FILE and set a real value."
    exit 1
    ;;
esac

# Portable SHA-256 (POSIX uses sha256sum, macOS uses shasum -a 256)
hash_file() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    log "ERROR: neither sha256sum nor shasum available"
    exit 1
  fi
}

# Look up the previously-recorded hash for a path in STATE_FILE.
# Returns empty string if path not seen before.
recorded_hash() {
  local target="$1"
  awk -F'|' -v p="$target" '$1 == p { print $2; exit }' "$STATE_FILE"
}

# Build the prioritized candidate list of files needing (re-)ingest.
# A file qualifies if:
#   - never seen before, OR
#   - seen before but content has changed (hash mismatch)
candidates=()
forced=()  # files that need --force flag because they were previously ingested

queue_if_changed() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local current
  current=$(hash_file "$f")
  local prior
  prior=$(recorded_hash "$f")
  if [[ -z "$prior" ]]; then
    candidates+=("$f")
  elif [[ "$prior" != "$current" ]]; then
    candidates+=("$f")
    forced+=("$f")
  fi
}

# T1: top-level wiki files (highest leverage)
for f in \
  "$WIKI_ROOT/rules.md" \
  "$WIKI_ROOT/false-beliefs.md" \
  "$WIKI_ROOT/hot.md" \
  "$WIKI_ROOT/log.md" \
  "$WIKI_ROOT/index.md" \
  "$WIKI_ROOT/pipeline.md" \
  "$AGENCY_ROOT/CLAUDE.md" \
  "$FRAMEWORK_ROOT/orgs/$ORG/knowledge.md"; do
  queue_if_changed "$f"
done

# T2..T5: walk each subdir, alphabetical within tier
for tier_dir in concepts explorations entities synthesis; do
  if [[ -d "$WIKI_ROOT/$tier_dir" ]]; then
    while IFS= read -r f; do
      queue_if_changed "$f"
    done < <(find "$WIKI_ROOT/$tier_dir" -maxdepth 1 -name "*.md" -type f | sort)
  fi
done

total=${#candidates[@]}

if [[ $total -eq 0 ]]; then
  log "No new or changed files to ingest. All caught up."
  exit 0
fi

# Slice to the daily budget
batch=("${candidates[@]:0:$FILES_PER_RUN}")
batch_count=${#batch[@]}

log "Daily ingest run: $batch_count of $total pending files (new + changed)."

# Determine if any file in batch is in the forced list (changed content)
needs_force=0
for f in "${batch[@]}"; do
  for forced_f in "${forced[@]:-}"; do
    if [[ "$f" == "$forced_f" ]]; then
      needs_force=1
      break 2
    fi
  done
done

force_flag=""
if [[ $needs_force -eq 1 ]]; then
  force_flag="--force"
  log "Batch includes changed files; using --force to re-embed."
fi

# Run ingest. Use process substitution to capture exit code without losing tee output.
if bash "$FRAMEWORK_ROOT/bus/kb-ingest.sh" "${batch[@]}" \
      --org "$ORG" \
      --instance "$INSTANCE_ID" \
      --scope shared \
      $force_flag 2>&1 | tee -a "$LOG_FILE"; then
  # On overall success, update STATE_FILE atomically: replace prior entries for these paths.
  tmp_state="${STATE_FILE}.tmp.$$"
  # Build set of paths in batch for quick lookup
  declare -A in_batch
  for f in "${batch[@]}"; do
    in_batch["$f"]=1
  done
  # Carry over prior entries that are NOT in this batch
  if [[ -s "$STATE_FILE" ]]; then
    while IFS='|' read -r path prior_hash; do
      if [[ -z "${in_batch[$path]:-}" ]]; then
        echo "$path|$prior_hash" >> "$tmp_state"
      fi
    done < "$STATE_FILE"
  fi
  # Append fresh entries for batch members
  for f in "${batch[@]}"; do
    h=$(hash_file "$f")
    echo "$f|$h" >> "$tmp_state"
  done
  mv -f "$tmp_state" "$STATE_FILE"

  log "Marked $batch_count files as ingested (path|hash recorded)."
  log "Remaining: $(( total - batch_count )) files queued for future runs."
else
  log "Ingest failed. State file NOT updated. Retry next run or run manually."
  # Codex finding 3: partial-success tracking is a known limitation here.
  # If kb-ingest.sh exited nonzero but processed some files, we conservatively retry the whole batch.
  # Future improvement: parse mmrag.py per-file output to record successful ones.
  exit 1
fi
